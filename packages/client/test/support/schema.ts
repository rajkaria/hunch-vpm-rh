import { readFileSync } from 'node:fs';
import { parse } from 'graphql';
import type { DocumentNode, FieldNode, SelectionSetNode, TypeNode, ValueNode, VariableDefinitionNode } from 'graphql';

/**
 * Enough of graph-node's generated query API to check a document against a
 * subgraph schema.
 *
 * The alternative was to trust that the selections in `src/queries.ts` match
 * `subgraph/schema.graphql`, which is exactly the assumption that produced a
 * package of queries that could not run. This is a small model of the rules
 * graph-node actually applies — every selected field exists on its entity,
 * entity references need a selection set and scalars do not, `where` keys are
 * a field name plus a known operator suffix, and a filter on a reference takes
 * the referenced id as a String, not the entity's own type.
 */

interface FieldDef {
  name: string;
  /** The named type, with `!` and list brackets stripped. */
  type: string;
  list: boolean;
}

interface TypeDef {
  name: string;
  kind: 'object' | 'enum';
  fields: Map<string, FieldDef>;
}

export interface SchemaModel {
  types: Map<string, TypeDef>;
  /** Root query field name -> entity type, for both the singular and the plural. */
  roots: Map<string, { type: string; list: boolean }>;
}

/**
 * How a `where` value is typed once graph-node has generated the filter input.
 * A reference is filtered by the id of the thing it points at, which is a
 * `String` — the single most common way to get a document rejected.
 */
function filterTypeOf(model: SchemaModel, field: FieldDef): string {
  const target = model.types.get(field.type);
  if (target?.kind === 'object') return 'String';
  if (target?.kind === 'enum') return field.type;
  return field.type === 'ID' ? 'ID' : field.type;
}

const FILTER_SUFFIXES = [
  '_not_in',
  '_not_contains_nocase',
  '_not_contains',
  '_not_starts_with_nocase',
  '_not_starts_with',
  '_not_ends_with_nocase',
  '_not_ends_with',
  '_contains_nocase',
  '_contains',
  '_starts_with_nocase',
  '_starts_with',
  '_ends_with_nocase',
  '_ends_with',
  '_not',
  '_gte',
  '_gt',
  '_lte',
  '_lt',
  '_in',
];

/** Suffixes that take a list of the base type rather than one value. */
const LIST_SUFFIXES = new Set(['_in', '_not_in']);

function namedType(node: TypeNode): { name: string; list: boolean } {
  if (node.kind === 'NonNullType') return namedType(node.type);
  if (node.kind === 'ListType') return { name: namedType(node.type).name, list: true };
  return { name: node.name.value, list: false };
}

export function loadSchema(path: string): SchemaModel {
  const document = parse(readFileSync(path, 'utf8'));
  const types = new Map<string, TypeDef>();

  for (const definition of document.definitions) {
    if (definition.kind === 'EnumTypeDefinition') {
      types.set(definition.name.value, { name: definition.name.value, kind: 'enum', fields: new Map() });
      continue;
    }
    if (definition.kind !== 'ObjectTypeDefinition') continue;
    const fields = new Map<string, FieldDef>();
    for (const field of definition.fields ?? []) {
      const { name, list } = namedType(field.type);
      fields.set(field.name.value, { name: field.name.value, type: name, list });
    }
    types.set(definition.name.value, { name: definition.name.value, kind: 'object', fields });
  }

  const roots = new Map<string, { type: string; list: boolean }>();
  for (const type of types.values()) {
    if (type.kind !== 'object' || !type.fields.has('id')) continue;
    const singular = type.name[0]!.toLowerCase() + type.name.slice(1);
    roots.set(singular, { type: type.name, list: false });
    roots.set(`${singular}s`, { type: type.name, list: true });
  }
  return { types, roots };
}

function valueTypeName(value: ValueNode): string | null {
  switch (value.kind) {
    case 'IntValue':
      return 'Int';
    case 'StringValue':
      return 'String';
    case 'BooleanValue':
      return 'Boolean';
    case 'EnumValue':
      return 'Enum';
    default:
      return null;
  }
}

function checkWhere(
  model: SchemaModel,
  typeName: string,
  value: ValueNode,
  variables: Map<string, { name: string; list: boolean }>,
  path: string,
  errors: string[],
): void {
  if (value.kind !== 'ObjectValue') {
    errors.push(`${path}: \`where\` must be an object literal`);
    return;
  }
  const type = model.types.get(typeName);
  for (const argument of value.fields) {
    const key = argument.name.value;
    if (key === 'and' || key === 'or') continue;
    const suffix = FILTER_SUFFIXES.find((candidate) => key.endsWith(candidate) && key.length > candidate.length);
    const base = suffix === undefined ? key : key.slice(0, -suffix.length);
    const field = type?.fields.get(base);
    if (field === undefined) {
      errors.push(`${path}: \`${key}\` filters ${typeName}.${base}, which does not exist`);
      continue;
    }
    const expected = filterTypeOf(model, field);
    if (argument.value.kind === 'Variable') {
      const declared = variables.get(argument.value.name.value);
      if (declared === undefined) {
        errors.push(`${path}: $${argument.value.name.value} is not declared`);
        continue;
      }
      if (declared.name !== expected) {
        errors.push(
          `${path}: \`${key}\` takes ${expected} (${typeName}.${base} is ${field.type}), but $${argument.value.name.value} is declared ${declared.name}`,
        );
      }
      const wantsList = suffix !== undefined && LIST_SUFFIXES.has(suffix);
      if (declared.list !== wantsList) {
        errors.push(`${path}: \`${key}\` ${wantsList ? 'takes' : 'does not take'} a list`);
      }
      continue;
    }
    const literal = valueTypeName(argument.value);
    // A BigInt or Bytes literal arrives as a string; an enum arrives bare.
    if (literal === 'Enum' && model.types.get(expected)?.kind !== 'enum') {
      errors.push(`${path}: \`${key}\` is ${expected}, not an enum`);
    }
  }
}

function checkSelection(
  model: SchemaModel,
  typeName: string,
  selectionSet: SelectionSetNode,
  variables: Map<string, { name: string; list: boolean }>,
  path: string,
  errors: string[],
): void {
  const type = model.types.get(typeName);
  if (type === undefined) {
    errors.push(`${path}: unknown type ${typeName}`);
    return;
  }
  for (const selection of selectionSet.selections) {
    if (selection.kind !== 'Field') {
      errors.push(`${path}: only plain fields are modelled here`);
      continue;
    }
    const node: FieldNode = selection;
    const field = type.fields.get(node.name.value);
    const where = `${path}.${node.name.value}`;
    if (field === undefined) {
      errors.push(`${where}: ${typeName} has no field \`${node.name.value}\``);
      continue;
    }
    const target = model.types.get(field.type);
    const isEntity = target?.kind === 'object';
    if (isEntity && node.selectionSet === undefined) {
      errors.push(`${where}: ${field.type} is an entity reference and needs a selection set`);
      continue;
    }
    if (!isEntity && node.selectionSet !== undefined) {
      errors.push(`${where}: ${field.type} is a scalar and cannot have a selection set`);
      continue;
    }
    for (const argument of node.arguments ?? []) {
      if (argument.name.value === 'where') {
        checkWhere(model, field.type, argument.value, variables, where, errors);
        continue;
      }
      if (argument.name.value === 'orderBy') {
        const by = argument.value.kind === 'EnumValue' ? argument.value.value : null;
        if (by === null || !(target?.fields.has(by) ?? false)) {
          errors.push(`${where}: cannot order ${field.type} by \`${String(by)}\``);
        }
        continue;
      }
      if (!['first', 'skip', 'orderDirection', 'id', 'block', 'subgraphError'].includes(argument.name.value)) {
        errors.push(`${where}: unexpected argument \`${argument.name.value}\``);
      }
    }
    if (node.selectionSet !== undefined) {
      checkSelection(model, field.type, node.selectionSet, variables, where, errors);
    }
  }
}

/** `_meta` is generated rather than declared, so it is modelled by hand. */
function checkMeta(selectionSet: SelectionSetNode, path: string, errors: string[]): void {
  const allowed = new Map<string, string[]>([
    ['block', ['number', 'hash', 'timestamp', 'parentHash']],
    ['deployment', []],
    ['hasIndexingErrors', []],
  ]);
  for (const selection of selectionSet.selections) {
    if (selection.kind !== 'Field') continue;
    const children = allowed.get(selection.name.value);
    if (children === undefined) {
      errors.push(`${path}._meta has no field \`${selection.name.value}\``);
      continue;
    }
    for (const child of selection.selectionSet?.selections ?? []) {
      if (child.kind === 'Field' && !children.includes(child.name.value)) {
        errors.push(`${path}._meta.${selection.name.value} has no field \`${child.name.value}\``);
      }
    }
  }
}

function declaredVariables(definitions: readonly VariableDefinitionNode[] | undefined) {
  const variables = new Map<string, { name: string; list: boolean }>();
  for (const definition of definitions ?? []) {
    variables.set(definition.variable.name.value, namedType(definition.type));
  }
  return variables;
}

/**
 * Validate one query document against a schema model. Returns the problems it
 * found; an empty array means graph-node would accept the document.
 */
export function validateQuery(model: SchemaModel, document: string): string[] {
  const errors: string[] = [];
  let parsed: DocumentNode;
  try {
    parsed = parse(document);
  } catch (error) {
    return [`does not parse: ${(error as Error).message}`];
  }

  for (const definition of parsed.definitions) {
    if (definition.kind !== 'OperationDefinition') continue;
    const variables = declaredVariables(definition.variableDefinitions);
    const used = new Set<string>();
    JSON.stringify(definition, (key, value: unknown) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        (value as { kind?: string }).kind === 'Variable' &&
        key !== 'variable'
      ) {
        used.add(((value as { name: { value: string } }).name).value);
      }
      return value;
    });
    for (const name of used) {
      if (!variables.has(name)) errors.push(`$${name} is used but not declared`);
    }

    for (const selection of definition.selectionSet.selections) {
      if (selection.kind !== 'Field') continue;
      const name = selection.name.value;
      if (name === '_meta') {
        if (selection.selectionSet !== undefined) checkMeta(selection.selectionSet, 'query', errors);
        continue;
      }
      const root = model.roots.get(name);
      if (root === undefined) {
        errors.push(`query.${name}: no such root field`);
        continue;
      }
      for (const argument of selection.arguments ?? []) {
        if (argument.name.value === 'where') {
          checkWhere(model, root.type, argument.value, variables, `query.${name}`, errors);
        } else if (argument.name.value === 'orderBy') {
          const by = argument.value.kind === 'EnumValue' ? argument.value.value : null;
          if (by === null || !(model.types.get(root.type)?.fields.has(by) ?? false)) {
            errors.push(`query.${name}: cannot order ${root.type} by \`${String(by)}\``);
          }
        } else if (!['first', 'skip', 'orderDirection', 'id', 'block', 'subgraphError'].includes(argument.name.value)) {
          errors.push(`query.${name}: unexpected argument \`${argument.name.value}\``);
        }
      }
      if (selection.selectionSet !== undefined) {
        checkSelection(model, root.type, selection.selectionSet, variables, `query.${name}`, errors);
      }
    }
  }
  return errors;
}
