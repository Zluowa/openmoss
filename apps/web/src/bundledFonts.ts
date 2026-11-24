// FILE: bundledFonts.ts
// Purpose: Loads the fonts Moss ships and its interface and code font stacks.
// Layer: Web bootstrap
// Why: bootstrap.ts imports this before any screen draws, so the screens drawn before the app
//      (signed out, pairing failed) use the same faces and stacks as the app. Nothing here
//      reaches another site: the font files are part of the app bundle.

import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono";
import "./fonts.css";
import "./fontStacks.css";
