SHELL := /bin/bash
.DEFAULT_GOAL := help

PACKAGE  := hunch_vpm
VERSION  := v0.1.0
# `substreams pack` writes <name>-<version>.spkg with underscores turned into hyphens.
SPKG     ?= $(subst _,-,$(PACKAGE))-$(VERSION).spkg
WASM     := target/wasm32-unknown-unknown/release/hunch_vpm_substreams.wasm
TARGET   := wasm32-unknown-unknown

# Where `substreams run` streams blocks from. This needs a Firehose for Arc to exist;
# see the "Open dependency" section of README.md. Override for any other chain.
ENDPOINT ?= arc-testnet.streamingfast.io:443

# Where `substreams alpha service deploy` sends the package. This is the hosted sink,
# not the data endpoint above.
DEPLOY_ENDPOINT ?= https://deploy.streamingfast.io

# Contract addresses, passed to both parameterised modules. All zero until deployment;
# with these values the package matches nothing, which is the honest default.
VESTED   ?= 0x0000000000000000000000000000000000000000
CLASSIC  ?= 0x0000000000000000000000000000000000000000
FACTORY  ?= 0x0000000000000000000000000000000000000000
RESOLVER ?= 0x0000000000000000000000000000000000000000
PARAMS   := vested=$(VESTED)&classic=$(CLASSIC)&factory=$(FACTORY)&resolver=$(RESOLVER)

START ?= 0
STOP  ?= +1000

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-24s\033[0m %s\n", $$1, $$2}'

# ------------------------------------------------------------------ build

.PHONY: build
build: ## Compile the modules to wasm (release)
	rustup target add $(TARGET) 2>/dev/null || true
	cargo build --release --target $(TARGET)
	@ls -l $(WASM)

.PHONY: pack
pack: build ## Build and pack a .spkg for distribution
	$(call need,substreams)
	substreams pack substreams.yaml
	@ls -l $(SPKG)

.PHONY: protogen
protogen: ## Regenerate src/pb from proto/ (commit the result)
	cargo run --quiet --manifest-path protogen/Cargo.toml
	cargo fmt

.PHONY: clean
clean: ## Remove build output
	cargo clean
	cargo clean --manifest-path protogen/Cargo.toml
	rm -f $(SPKG)

# ------------------------------------------------------------------ checks

.PHONY: test
test: ## Run the unit tests on the host target
	cargo test

.PHONY: lint
lint: ## rustfmt and clippy over the lib AND the tests (CI lints the lib only)
	cargo fmt --check
	cargo clippy --all-targets --target $(TARGET) -- -D warnings

.PHONY: verify-vendored-proto
verify-vendored-proto: ## Check proto/sink against the substreams-database-change crate
	python3 tools/verify-vendored-proto.py

.PHONY: check
check: lint test verify-vendored-proto build ## Everything, in the order CI would care about

# ------------------------------------------------------------------ run

.PHONY: run
run: build ## Stream db_out from a Firehose endpoint (needs ENDPOINT and addresses)
	$(call need,substreams)
	substreams run substreams.yaml db_out \
		-e $(ENDPOINT) \
		-s $(START) -t $(STOP) \
		-p map_markets='$(PARAMS)' \
		-p map_positions='$(PARAMS)'

.PHONY: gui
gui: build ## Same as `run`, in the terminal UI
	$(call need,substreams)
	substreams gui substreams.yaml db_out \
		-e $(ENDPOINT) \
		-s $(START) -t $(STOP) \
		-p map_markets='$(PARAMS)' \
		-p map_positions='$(PARAMS)'

# ------------------------------------------------------------------ deploy

.PHONY: token
token: ## Mint a short-lived API token from the Portal API (needs SUBSTREAMS_API_KEY)
	@test -n "$$SUBSTREAMS_API_KEY" || { echo "set SUBSTREAMS_API_KEY first"; exit 1; }
	@curl -sS -X POST -H "Content-Type: application/json" \
		-d '{"api_key":"'"$$SUBSTREAMS_API_KEY"'"}' \
		https://auth.streamingfast.io/v1/auth/issue \
		| python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'

.PHONY: deploy
deploy: pack ## Deploy the packed .spkg to the hosted sink
	$(call need,substreams)
	@test -n "$$SUBSTREAMS_API_TOKEN" || { echo "set SUBSTREAMS_API_TOKEN (see: make token)"; exit 1; }
	substreams alpha service deploy $(SPKG) --endpoint $(DEPLOY_ENDPOINT)

.PHONY: deployments
deployments: ## List hosted deployments
	$(call need,substreams)
	substreams alpha service list --endpoint $(DEPLOY_ENDPOINT)

# ------------------------------------------------------------------ helpers

# Fail with something readable instead of "command not found". Only the pack, run and
# deploy targets need the CLI; build, test and lint do not, which is why CI can check this
# package without installing it.
define need
	@command -v $(1) >/dev/null || { \
		echo "$(1) is not on PATH."; \
		echo "Install the release for your platform from"; \
		echo "  https://github.com/streamingfast/substreams/releases"; \
		exit 1; }
endef
