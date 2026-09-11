# Install

## Path A—From the SillyTavern UI (recommended)

1. Open SillyTavern.
2. Click the Extensions icon (puzzle piece) in the top bar.
3. Click "Install Extension" at the top right of the panel.
4. Paste: `https://github.com/EvaL3n4/SillyTavern-STARmem`
5. Click "Install".
6. STARmem appears in the extension list. Toggle it on.

No build step and no `npm install` are needed—ST clones the repo and loads
`index.js` directly as an ES module.

## Path B—Local clone (development)

```bash
cd <path-to-SillyTavern>/public/scripts/extensions/third-party
git clone https://github.com/EvaL3n4/SillyTavern-STARmem.git
```

Restart SillyTavern. The extension loads from the cloned directory.

Dev tooling (lint, typecheck, tests) needs dependencies installed:

```bash
cd <path>/public/scripts/extensions/third-party/SillyTavern-STARmem
npm install
npm test         # jest unit + integration
npm run lint
npm run typecheck
npm run bench    # local benchmark harness
npm run test:e2e # Playwright; requires a live local ST on localhost:8000 (skips otherwise)
```

## Verifying the install

1. Enable STARmem, then open its panel in the Extensions tab—a collapsible
   "STARmem" drawer in the extensions list.
2. Pick a **connection profile** for extraction. Chat capture works without
   one, but consolidation cannot run. Note the panel's warning only fires
   when the Connection Manager has no profiles configured at all—if you
   have profiles but skip the pick, no warning shows and consolidation
   still fails until a profile is selected.
3. Send a few messages. Each assistant reply is captured as a working entry;
   after roughly 10 replies (or 60 seconds of quiet), consolidation runs one
   extraction pass, and the small dot next to the send button briefly shows
   the activity.
4. Use the panel's **Open Memory Viewer** button to inspect what has been
   recorded: Working, Episodic, Persona, Graph, and Traces tabs.

## Uninstall

Disable from the Extensions panel, or:

```bash
rm -rf <path-to-ST>/public/scripts/extensions/third-party/SillyTavern-STARmem
```

State stored in `chatMetadata['STARmem']` is preserved across reinstalls
because it lives in your chat files, not in the extension directory.
