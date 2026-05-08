// One eval replaces a chain of navigate_page, wait_for, evaluate_script,
// list_console_messages, and conditional retry tool calls.
await mcp.call("new_page", { url: "https://example.com" });

for (let i = 0; i < 20; i += 1) {
  const title = await mcp.call("evaluate_script", {
    function: "() => document.title"
  });
  if (/Example Domain/.test(title)) break;
  await sleep(250);
}

const page = await mcp.call("evaluate_script", {
  function: `() => ({
    title: document.title,
    heading: document.querySelector("h1")?.textContent,
    links: [...document.querySelectorAll("a")].map(a => ({
      text: a.textContent,
      href: a.href
    }))
  })`
});

const consoleMessages = await mcp.call("list_console_messages", {});

return {
  page,
  consoleMessageCount: consoleMessages.length ?? consoleMessages?.messages?.length ?? 0
};
