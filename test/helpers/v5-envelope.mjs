// Wraps a fake profile's documents in the ProjectionLab 5 export envelope,
// filling an empty Current Finances and settings document when the test
// does not supply one. `documents` is used as given, so pass a copy when the
// caller keeps mutating the original.

export function asV5Export(documents) {
  return {
    schema: 1,
    exportedAt: 1,
    documents: {
      currentFinances: { schema: 5, accounts: {} },
      settings: { schema: 5 },
      ...documents,
    },
  };
}
