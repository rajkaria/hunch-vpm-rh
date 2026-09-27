import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { cleanup, render } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

import { SiteHeader } from '@/components/chrome/SiteHeader';
import { Hero } from '@/components/landing/Hero';
import { PriceTape } from '@/components/landing/PriceTape';
import { EarlyVsLate, ILLUSTRATION_PROOF } from '@/components/proof/EarlyVsLate';
import { TICKERS } from '@/content/tickers';

afterEach(cleanup);

/**
 * The copy rules from docs/spec/05-web-app.md, as a test over the source:
 *
 * - no em dash in any user-facing string (JSX text or a string literal; comments are not copy);
 * - no hype words;
 * - outcomes are UP and DOWN, never YES or NO;
 * - "vested", "parimutuel", "vintage", "κ" and "accumulator" never appear above the fold on `/`
 *   (the header, the price tape, the hero and the proof card) or on any button.
 */

// jsdom gives import.meta.url an http scheme, so resolve from the package directory vitest runs in.
const SRC = [resolve(process.cwd(), 'src'), resolve(process.cwd(), 'apps/web/src')].find((dir) => existsSync(dir)) ?? 'src';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

interface Copy {
  file: string;
  line: number;
  text: string;
}

/** Every string a user could read: JSX text, string and template literals. Comments are skipped by construction. */
function userStrings(file: string): Copy[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Copy[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxText(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const value = node.text;
      if (value.trim() !== '') {
        out.push({ file: relative(SRC, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: value });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const FILES = sourceFiles(SRC);
const ALL = FILES.flatMap(userStrings);

const HYPE = /\b(revolutionar\w*|seamless\w*|unleash\w*|game[- ]chang\w*|cutting[- ]edge|next[- ]gen\w*|supercharg\w*|effortless\w*|world[- ]class|groundbreaking|best[- ]in[- ]class|blazing\w*|skyrocket\w*|to the moon)\b/i;
const JARGON = /vested|parimutuel|vintage|κ|kappa|accumulator/i;

describe('copy rules over every user-facing string in apps/web/src', () => {
  it('scans a real amount of copy', () => {
    expect(FILES.length).toBeGreaterThan(40);
    expect(ALL.length).toBeGreaterThan(500);
  });

  it('has no em dash', () => {
    const hits = ALL.filter((copy) => copy.text.includes('—'));
    expect(hits.map((hit) => `${hit.file}:${hit.line} ${hit.text.slice(0, 60)}`)).toEqual([]);
  });

  it('has no hype words', () => {
    const hits = ALL.filter((copy) => HYPE.test(copy.text));
    expect(hits.map((hit) => `${hit.file}:${hit.line} ${hit.text.slice(0, 60)}`)).toEqual([]);
  });

  it('never calls an outcome YES or NO', () => {
    const hits = ALL.filter((copy) => /\b(YES|NO)\b/.test(copy.text));
    expect(hits.map((hit) => `${hit.file}:${hit.line} ${hit.text.slice(0, 60)}`)).toEqual([]);
  });
});

/** Text inside every button-like element: <Button>, <ButtonLink>, <button>, or anything styled with buttonClass(). */
function buttonStrings(file: string): Copy[] {
  const text = readFileSync(file, 'utf8');
  if (!file.endsWith('.tsx')) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Copy[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // Class names and attribute values are not copy; JSX text and strings in children are.
      const parent = node.parent;
      const isAttribute = ts.isJsxAttribute(parent) || (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent));
      if (!isAttribute && node.text.trim() !== '') {
        out.push({ file: relative(SRC, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
      }
    }
    ts.forEachChild(node, collect);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(source);
      const classAttr = node.openingElement.attributes.properties.find(
        (property) => ts.isJsxAttribute(property) && property.name.getText(source) === 'className',
      );
      const styledAsButton = classAttr !== undefined && classAttr.getText(source).includes('buttonClass(');
      if (tag === 'Button' || tag === 'ButtonLink' || tag === 'button' || styledAsButton) {
        node.children.forEach(collect);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe('the first screen and every button stay in plain words', () => {
  it('no button anywhere uses the mechanism vocabulary', () => {
    const labels = FILES.flatMap(buttonStrings);
    expect(labels.length).toBeGreaterThan(10);
    const hits = labels.filter((label) => JARGON.test(label.text));
    expect(hits.map((hit) => `${hit.file}:${hit.line} ${hit.text}`)).toEqual([]);
  });

  it('the header, the price tape, the hero and the proof card on / use none of it', () => {
    const now = 1_790_000_000;
    const { container } = render(
      <div>
        <SiteHeader />
        <PriceTape
          now={now}
          initial={{
            status: 'live',
            readAt: now,
            readings: TICKERS.map((ticker) => ({
              ticker: ticker.ticker,
              name: ticker.name,
              feed: ticker.feed,
              answer: '22566018707',
              roundId: '1',
              updatedAt: now - 60,
            })),
          }}
        />
        <Hero live={false} />
        <EarlyVsLate proof={ILLUSTRATION_PROOF} />
      </div>,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Call it early.');
    expect(text).not.toMatch(JARGON);
    expect(text).not.toContain('—');
  });
});
