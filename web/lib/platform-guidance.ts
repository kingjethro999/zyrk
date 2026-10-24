export const bootstrapCommand = "npm install --global zyrk";

export type PlatformGuidance = {
  id: "linux" | "macos" | "windows";
  name: string;
  status: "initial-target" | "evidence-gated" | "unavailable";
  summary: string;
  projectCommand: string | null;
  evidence: string;
};

export const platformGuidance: readonly PlatformGuidance[] = [
  {
    id: "linux",
    name: "Linux",
    status: "initial-target",
    summary:
      "The initial native shared-store target. Bootstrap with npm, then install project dependencies with Zyrk.",
    projectCommand: "zyrk install",
    evidence:
      "Ubuntu runs the repository check gate; support remains pre-release.",
  },
  {
    id: "macos",
    name: "macOS",
    status: "evidence-gated",
    summary:
      "The full check gate runs in CI, but that alone does not establish the native filesystem and framework support boundary.",
    projectCommand: null,
    evidence:
      "Treat native project installation as evidence-gated until its release checklist is complete.",
  },
  {
    id: "windows",
    name: "Windows",
    status: "unavailable",
    summary:
      "The CLI can be bootstrapped for inspection, but native shared-store project installation is unavailable.",
    projectCommand: null,
    evidence:
      "Windows support remains blocked until an account-isolating ACL implementation passes real filesystem tests.",
  },
];
