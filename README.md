# CScout for VS Code

[CScout](https://github.com/dspinellis/cscout) is Diomidis Spinellis's C source code analyzer.

This extension puts that analysis inside VS Code itself. Instead of switching windows to look something up, you hover over a variable and see its type, scope, and complexity right there. Go to Definition and Find All References use CScout's analysis. Renaming a variable with F2 follows it correctly through macros and across files, something a plain text-based rename can't do safely in C.

The extension will be published to VS Code Marketplace.

## What it does

- Hover, go to definition, and find references
- Renaming that understands macros and cross-file identifiers
- Diagnostics for unused identifiers and variables that should be `static` but aren't
- CodeLens above each function showing its callers, callees, and complexity
- Sidebar views for identifiers, functions, and files, grouped the same way CScout groups them
- Call graphs and include graphs, when Graphviz is installed

## Installation & Setup

You can install this extension directly into VS Code without building it from source.

### 1. Prerequisites
You must have the following installed and available in your system `PATH`:
- **CScout** (ensure you are using the `csapi` branch containing the REST API backend)
- **Python 3**
- **sqlite3**
- **Graphviz (dot)** (optional, but required for rendering dependency and call graphs)

### 2. Install the Extension
1. Download the latest `.vsix` release file from the [GitHub Releases](https://github.com/cscout-project/cscout-vscode/releases) page.
2. Open VS Code and navigate to the **Extensions** view (`Ctrl+Shift+X`).
3. Click the `...` menu at the top right of the Extensions view.
4. Select **Install from VSIX...** and choose the downloaded `.vsix` file.

## Getting Started

1. Open a C project folder in VS Code (CMake, Meson, Makefiles, Autotools, or an existing `.cs` CScout workspace).
2. Open the **CScout** view in the VS Code Activity Bar on the left.
3. In the CScout Control Panel, click **Tutorial**. This interactive walkthrough will guide you through:
   - Setting up your paths (CScout binary, Python 3, etc.)
   - Automatically verifying your environment with the **Verify Setup** tool
   - Triggering your first analysis
4. Once analysis completes, you can hover over identifiers, view metrics, and explore dependency graphs directly inside VS Code!

## About

I built this as part of Google Summer of Code 2026, to bring CScout's analysis into the editor.
