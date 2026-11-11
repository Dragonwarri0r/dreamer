#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
dreamer_node=${DREAMER_NODE_BIN:-node}
"$dreamer_node" --eval 'const [major,minor]=process.versions.node.split(".").map(Number);if(major!==24||minor<14){console.error("Dreamer MCP 需要 Node 24.14–24.x；请设置 DREAMER_NODE_BIN 为 Node 24 的绝对路径。");process.exit(1);}'
exec "$dreamer_node" --import tsx scripts/writing-mcp.ts
