# Draft: REA feature request

Template: Feature request. Status: draft, not posted.

Context checked before drafting: #1669 (operator tool selection) was closed because "clients lazy-load tools"; #723 asks to reduce discovery repetition while keeping the complete catalog; #2019 reports context exhaustion with DeepSeek through Claude Code. This request keeps the complete catalog and does not hide tools.

---

**Title:** Advertise a stable family for each tool in `tools/list` metadata, and document that DeepSeek Harness does not lazy-load

### Before submitting

- [x] I searched the open and closed issues and pull requests for a related proposal.
- [x] I understand the contribution scope must be reviewed before integration; open questions are welcome here.
- [x] This request does not include credentials, private samples, or sensitive target data.

### Area

MCP or agent integration

### Current limitation

DeepSeek Harness, which `rea setup --client dsh` supports, does not lazy-load MCP tools: `dsh-mcp-client` registers all of them and the Harness sends every input schema with every request. With REA 6.7.0 on DeepSeek Harness 0.2.0-rc.2, the first request of a headless task reported 249,653 input tokens. Claude Code routed to DeepSeek turns tool search off for the same reason (#2019 and the client-configuration guide). So the premise in #1669 does not hold for these hosts.

We built a Harness plugin that indexes MCP servers lazily: a compact family index in the system prompt plus search/describe/call tools. REA behind it starts on demand and the same task's first request reported about 9.2k input tokens. The plugin has to guess families from tool names; for REA we maintain a hand-written mapping of all 207 tools to 14 families, which goes stale whenever tools are added or renamed.

### Use cases

- Lazy-indexing clients and gateways (our Harness plugin, MCP gateways, `search_tools`-style layers) group REA's tools for a compact index and family browsing.
- Hosts without tool search can still show the model which capability areas exist without sending 668 KB of schemas.

### Desired outcome and success criteria

- Each tool in `tools/list` carries a stable family in `_meta`, for example `"_meta": {"io.github.morluto/rea": {"family": "javascript-electron"}}`, taken from the existing contract families in `src/contracts`.
- Optionally a one-line family description, either in server instructions or in a separate `_meta` field on the first tool of each family.
- No tool is hidden or renamed; `tools/list` stays the complete canonical inventory and input schemas are unchanged.
- The DeepSeek Harness section of `docs/client-configuration.md` notes the measured per-request cost when REA is registered directly.

### Expected interaction with targets

None. This only changes discovery metadata.

### Alternatives considered

- Operator tool selection (#1669): closed, and hides tools.
- Client-side name heuristics: our generic heuristic leaves 67 of 207 REA tools in a catch-all group.
