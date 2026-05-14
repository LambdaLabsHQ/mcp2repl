(async () => {
  globalThis.smokeRuntime = {
    add: async ({ a, b }) => ({ sum: a + b })
  };

  const large = {
    keep: "ok",
    options: [
      {
        productName: "Example",
        display: "x".repeat(400),
        evidence: ["one", "two", "three"]
      }
    ]
  };

  const projected = api.project(large, {
    keep: true,
    options: {
      $slice: 1,
      $items: {
        productName: true,
        evidence: { $slice: 2, $items: true }
      }
    }
  });
  const autoFit = await api.print(large, { maxChars: 220 });
  const tooLarge = await api.print(large, { maxChars: 120, fit: false });
  const printed = await api.print(large, {
    projection: {
      keep: true,
      options: { $slice: 1, $items: { productName: true } }
    },
    maxChars: 120
  });
  const saved = await api.saveArtifact("smoke-runtime.json", { ok: true });
  const restored = await api.readArtifact(saved);

  return {
    projected,
    tooLarge: {
      ok: tooLarge.ok,
      error: tooLarge.error,
      largeField: tooLarge.largeFields[0].path,
      artifactKind: tooLarge.artifact.kind
    },
    autoFit: {
      ok: autoFit.ok,
      compacted: autoFit.printer.compacted,
      artifactKind: autoFit.printer.artifact.kind
    },
    printed: {
      ok: printed.ok,
      result: printed.result
    },
    artifact: {
      name: saved.name,
      kind: saved.kind,
      hasPath: Object.prototype.hasOwnProperty.call(saved, "path"),
      restored
    }
  };
})()
