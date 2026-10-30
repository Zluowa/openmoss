// Purpose: Compatibility shim for upstream call sites; re-exports the inline Moss mark under its
// upstream name. Native Moss code imports `MossLogoMark` from `~/components/MossLogoMark`.
// Layer: Shared app branding primitive

export { MossLogoMark as MossLogo } from "~/components/MossLogoMark";
