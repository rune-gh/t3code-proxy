package config

import "github.com/rune-oai/t3code-proxy/internal/registry"

// ModelCatalogs selects optional sources for the process-wide model catalogs.
type ModelCatalogs = registry.CatalogSources
