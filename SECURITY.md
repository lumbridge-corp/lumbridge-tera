# Security

Report security bugs by email to security@lumbridgecorp.com, or use "Report a vulnerability" on this repo's Security tab. Do not open a public issue with exploit details.

Include the commit or version you run, your OS, browser and GPU, whether the problem is local or remote, steps to reproduce, and the impact you expect. Remove secrets from logs and examples. A small reproduction helps.

The latest release and the latest `main` are supported. We answer in the same email thread. There is no fixed response deadline.

## Trust model

- **Worlds and camera scripts are untrusted, shareable data.** They are JSON plus assets; loading one must never run code on the host. A world or script that can run a command, read a file outside its folder through the MCP server or the CLI, or make the page fetch something other than its own assets and the addresses in it, is a security bug.
- **The MCP server keeps an agent inside `TERA_WORLDS`.** Every path is resolved inside that root; anything outside is refused. `asset_import` accepts an allowlist of file types up to a size cap. A way around the path guard or the allowlist is in scope.
- **Local servers.** `tera serve` and `npm run dev` bind 127.0.0.1 by default and have no authentication. Binding them to another address is your choice; what they then serve is the world folder.
- **Gen workers** run model code on a GPU box. Set `TERA_TOKEN` and bind a private address; the worker refuses to listen on all interfaces without a token. URL inputs can be turned off with `TERA_ALLOW_URL_INPUT=0`; link-local and metadata addresses are refused.
- **The live feed** (`?live=`) applies whatever the server you point the page at sends. Only connect it to a server you trust.
