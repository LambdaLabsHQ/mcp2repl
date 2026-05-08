const target = "https://example.com";

await tools.new_page({ url: target });

let state;
for (let attempt = 0; attempt < 20; attempt += 1) {
  state = await tools.evaluate_script({
    function: "() => ({ readyState: document.readyState, heading: document.querySelector('h1')?.textContent || '' })"
  });

  if (state.readyState === "complete" && /Example Domain/.test(state.heading)) {
    break;
  }

  await sleep(250);
}

if (state?.readyState !== "complete" || !/Example Domain/.test(state.heading ?? "")) {
  throw new Error(`Page did not reach the expected state: ${inspect(state)}`);
}

const page = await tools.evaluate_script({
  function: `() => ({
    title: document.title,
    heading: document.querySelector("h1")?.textContent || "",
    links: [...document.querySelectorAll("a")].map((a) => ({
      text: a.textContent?.trim() || "",
      href: a.href
    })),
    timing: performance.getEntriesByType("navigation")[0]?.toJSON?.() || null
  })`
});

const consoleMessages = await tools.list_console_messages({});
const networkRequests = await tools.list_network_requests({});

return {
  page,
  diagnostics: {
    consoleMessageCount: consoleMessages.length ?? consoleMessages.messages?.length ?? 0,
    networkRequestCount: networkRequests.length ?? networkRequests.requests?.length ?? 0
  }
};
