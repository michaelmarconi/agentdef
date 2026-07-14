// Minimal manifest + skill + knowledge types for the formats agentdef actually
// emits. Compliance/SOD fields from the upstream spec are intentionally omitted:
// noord does not use them, so the adapters never read them. Knowledge is the
// exception: upstream's knowledge-index concept returns here, but generic — OKF
// frontmatter (see knowledge.ts) instead of upstream's index.yaml manifest.
export {};
