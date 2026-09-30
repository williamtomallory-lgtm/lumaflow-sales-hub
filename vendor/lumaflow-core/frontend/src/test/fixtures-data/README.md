# Test fixtures only

The JSON files in this directory contain invented records used exclusively by
unit and component tests. Runtime server modules must never import this
directory. A fresh installation returns empty business collections until data
is read from PostgreSQL or written through a backend API.
