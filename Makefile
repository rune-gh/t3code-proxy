# t3code-proxy developer tasks. Run `make` or `make help` for the list.

SHELL := /bin/sh
.DEFAULT_GOAL := help

IMAGE ?= ghcr.io/rune-oai/t3code-proxy
CONFIG ?= config.yaml
# Space-separated goos/goarch list for `make release`; empty means all targets.
TARGETS ?=

GO_PACKAGES := ./...
SHELL_SCRIPTS := scripts/*.sh docker-build.sh

.PHONY: help build web test test-web lint fmt fmt-check verify run release docker clean

help: ## Show this help
	@printf 'Usage: make <target>\n\nTargets:\n'
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-10s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

build: ## Build bin/t3code-proxy for this machine (embeds a staged web panel if present)
	@sh scripts/build.sh

web: ## Build the web panel and stage it for embedding
	@sh scripts/web.sh

test: ## Run Go tests
	go test ./...

test-web: ## Run web panel tests, lint, and build (bun run verify)
	cd web && bun install --frozen-lockfile && bun run verify

lint: fmt-check ## Check formatting, run go vet, and shellcheck the scripts
	go vet $(GO_PACKAGES)
	@if command -v shellcheck >/dev/null 2>&1; then shellcheck $(SHELL_SCRIPTS); else echo "shellcheck not installed; skipped"; fi

fmt: ## Format Go code with gofmt
	gofmt -w cmd internal sdk test examples

fmt-check:
	@files="$$(gofmt -l cmd internal sdk test examples)"; if [ -n "$$files" ]; then echo "gofmt needed:"; echo "$$files"; exit 1; fi

verify: lint test build test-web ## Everything CI runs

run: ## Run the server from source with $(CONFIG)
	go run ./cmd/server -config $(CONFIG)

release: ## Cross-build archives and checksums.txt into dist/ (TARGETS="linux/amd64 ..." to limit)
	@sh scripts/release.sh $(TARGETS)

docker: ## Build the container image $(IMAGE):dev
	docker build \
		--build-arg VERSION="$$(. scripts/buildinfo.sh && echo $$VERSION)" \
		--build-arg COMMIT="$$(git rev-parse --short=8 HEAD)" \
		--build-arg BUILD_DATE="$$(git log -1 --format=%cI HEAD)" \
		-t $(IMAGE):dev .

clean: ## Remove build outputs
	rm -rf bin dist web/dist internal/managementasset/embedded/management.html
