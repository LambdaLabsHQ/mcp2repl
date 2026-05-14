globalThis.demo = {
  add: async ({ a, b }) => ({ sum: a + b, x: globalThis.x })
};
