var total = 0;

for (let i = 0; i < 5; i += 1) {
  total = await mcp.call("math.add", { a: total, b: i });
}

globalThis.lastDemo = {
  title: await mcp.call("page.title"),
  total
};

return lastDemo;
