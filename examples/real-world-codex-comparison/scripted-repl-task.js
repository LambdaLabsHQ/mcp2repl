const urls = [
  "https://www.apple.com/macbook-air/",
  "https://www.apple.com/macbook-pro/",
  "https://www.apple.com/mac/compare/",
  "https://www.apple.com/us/shop/buy-mac/macbook-air",
  "https://www.apple.com/us/shop/buy-mac/macbook-pro"
];

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function sentences(text) {
  return normalize(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normalize)
    .filter((sentence) => sentence.length >= 25 && sentence.length <= 260);
}

function findPrices(text) {
  return unique(normalize(text).match(/\$\d[\d,]*(?:\.\d{2})?/g) ?? []).slice(0, 12);
}

function findFirst(text, patterns) {
  const lines = normalize(text).split(/(?<=[.!?])\s+|\n+|\s{2,}/).map(normalize);
  for (const pattern of patterns) {
    const match = lines.find((line) => pattern.test(line));
    if (match) return match;
  }
  return "unknown";
}

function findEvidence(text, patterns, limit = 4) {
  const found = [];
  for (const sentence of sentences(text)) {
    if (patterns.some((pattern) => pattern.test(sentence))) {
      found.push(sentence);
    }
  }
  return unique(found).slice(0, limit);
}

function priceNear(text, patterns) {
  const normalized = normalize(text);
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function setAppleUsEnglishSession() {
  await tools.new_page({ url: "https://www.apple.com/", timeout: 25000 });
  await tools.evaluate_script({
    function: `() => {
      document.cookie = "geo=US; Domain=.apple.com; Path=/; Max-Age=31536000; SameSite=Lax";
      document.cookie = "as_sfa=Mnx1c3x1c3x8ZW5fVVN8Y29uc3VtZXJ8MHwwfDA; Domain=.apple.com; Path=/; Max-Age=31536000; SameSite=Lax";
      try {
        localStorage.setItem("locale", "en_US");
        localStorage.setItem("preferredLocale", "en_US");
      } catch {}
      return {
        language: navigator.language,
        cookieHasGeoUs: document.cookie.includes("geo=US")
      };
    }`
  }).catch(() => {});
}

async function extractPage(url) {
  await tools.new_page({ url, timeout: 25000 });
  await tools.wait_for({ text: ["MacBook", "Buy", "Compare", "From"], timeout: 20000 }).catch(() => {});
  await tools.evaluate_script({
    function: `() => {
      for (const text of ["Accept", "Continue", "Close"]) {
        const button = Array.from(document.querySelectorAll("button"))
          .find((el) => new RegExp("^" + text + "$", "i").test((el.textContent || "").trim()));
        if (button) button.click();
      }
      return true;
    }`
  }).catch(() => {});

  return tools.evaluate_script({
    function: `() => {
      const normalize = (text) => String(text || "").replace(/\\s+/g, " ").trim();
      const body = normalize(document.body.innerText || "");
      const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
        .map((el) => normalize(el.textContent))
        .filter(Boolean)
        .slice(0, 80);
      const buttons = Array.from(document.querySelectorAll("button,a"))
        .map((el) => normalize(el.textContent || el.getAttribute("aria-label") || ""))
        .filter(Boolean)
        .slice(0, 160);
      const controls = Array.from(document.querySelectorAll("input,label,button,a,[role=button]"))
        .map((el) => ({
          tag: el.tagName,
          value: normalize(el.value || ""),
          text: normalize(el.textContent || el.getAttribute("aria-label") || el.value || "")
        }))
        .filter((entry) => entry.text || entry.value)
        .slice(0, 220);
      return {
        url: location.href,
        title: document.title,
        body,
        headings,
        buttons,
        controls
      };
    }`
  });
}

const pages = [];
await setAppleUsEnglishSession();
for (const url of urls) {
  pages.push(await extractPage(url));
}

const corpus = pages.map((page) => `${page.title}\n${page.headings.join("\n")}\n${page.body}`).join("\n\n");
const airText = pages
  .filter((page) => /macbook-air|buy-mac\/macbook-air|MacBook Air/i.test(page.url + " " + page.title))
  .map((page) => page.body)
  .join("\n");
const proText = pages
  .filter((page) => /macbook-pro|buy-mac\/macbook-pro|MacBook Pro/i.test(page.url + " " + page.title))
  .map((page) => page.body)
  .join("\n");
const compareText = pages.find((page) => /compare/i.test(page.url))?.body || corpus;

const airPrices = findPrices(airText);
const proPrices = findPrices(proText);
const allPrices = findPrices(corpus);
const airShopText = pages
  .filter((page) => /buy-mac\/macbook-air/i.test(page.url))
  .map((page) => `${page.controls.map((entry) => `${entry.value} ${entry.text}`).join("\n")}\n${page.body}`)
  .join("\n");
const proShopText = pages
  .filter((page) => /buy-mac\/macbook-pro/i.test(page.url))
  .map((page) => `${page.controls.map((entry) => `${entry.value} ${entry.text}`).join("\n")}\n${page.body}`)
  .join("\n");

const explicitPrices = {
  air13: priceNear(airShopText, [
    /13-inch[^$]*(\$\d[\d,]*(?:\.\d{2})?)/i,
    /13inch[^$]*(\$\d[\d,]*(?:\.\d{2})?)/i
  ]),
  air15: priceNear(airShopText, [
    /15-inch[^$]*(\$\d[\d,]*(?:\.\d{2})?)/i,
    /15inch[^$]*(\$\d[\d,]*(?:\.\d{2})?)/i
  ]),
  pro14: priceNear(proShopText, [
    /14-inch[^$]*(\$\d[\d,]*(?:\.\d{2})?)/i,
    /From\s+(\$\d[\d,]*(?:\.\d{2})?)/i
  ])
};

function option({
  scenario,
  productName,
  sourceText,
  officialUrl,
  priceFallback,
  explicitPrice,
  display,
  portability,
  pro = false
}) {
  const prices = findPrices(sourceText);
  const startingPrice = explicitPrice || priceFallback || prices[0] || "unknown";
  return {
    scenario,
    productName,
    officialUrl,
    visibleStartingPrice: startingPrice,
    configuredOrRelevantPrice: startingPrice,
    chip: findFirst(sourceText, [/M\d/i, /Apple silicon/i, /chip/i]),
    memory: findFirst(sourceText, [/16GB/i, /unified memory/i, /memory/i]),
    storage: findFirst(sourceText, [/512GB/i, /SSD/i, /storage/i]),
    display: display || findFirst(sourceText, [/13-inch/i, /14-inch/i, /15-inch/i, /Liquid Retina/i, /display/i]),
    weightOrPortability: portability || findFirst(sourceText, [/pounds/i, /thin/i, /light/i, /portable/i]),
    batteryOrPowerClaim: findFirst(sourceText, [/battery/i, /hours/i, /power/i]),
    portsOrExternalDisplayNotes: findFirst(sourceText, [/Thunderbolt/i, /ports/i, /external display/i, /HDMI/i, /SDXC/i]),
    upgradeTradeoffs: findFirst(sourceText, [/configure/i, /upgrade/i, /memory/i, /storage/i, /price/i]),
    whyGoodForUser: pro
      ? "Best fit when sustained performance, ports, display quality, and longer useful life matter more than minimum cost."
      : "Best fit when portability, battery life, quiet everyday work, and cost control matter most.",
    whyRiskyOrOverkill: pro
      ? "Likely overkill if the user mainly does browser work, video calls, documents, and light photo edits."
      : "May be limiting for heavier creative work, sustained external-display use, or workflows needing more ports.",
    evidence: findEvidence(sourceText, [/M\d/i, /16GB/i, /512GB/i, /battery/i, /display/i, /Thunderbolt/i, /\$\d/], 4)
  };
}

const options = [
  option({
    scenario: "Portable value option",
    productName: "13-inch MacBook Air",
    officialUrl: pages.find((page) => /buy-mac\/macbook-air/i.test(page.url))?.url || "https://www.apple.com/us/shop/buy-mac/macbook-air",
    sourceText: `${airText}\n${compareText}`,
    priceFallback: airPrices[0] || allPrices[0],
    explicitPrice: explicitPrices.air13,
    display: "13-inch MacBook Air; Apple public page also states 13.6 inches measured as a standard rectangle",
    portability: findFirst(compareText, [/Weight 2\.7 pounds/i, /2\.7 pounds/i]) || "2.7 pounds"
  }),
  option({
    scenario: "Larger-screen Air option",
    productName: "15-inch MacBook Air",
    officialUrl: pages.find((page) => /buy-mac\/macbook-air/i.test(page.url))?.url || "https://www.apple.com/us/shop/buy-mac/macbook-air",
    sourceText: `${airText}\n${compareText}`,
    priceFallback: airPrices[1] || airPrices[0] || allPrices[0],
    explicitPrice: explicitPrices.air15,
    display: "15-inch MacBook Air; Apple public page also states 15.3 inches measured as a standard rectangle",
    portability: findFirst(compareText, [/Weight 3\.3 pounds/i, /3\.3 pounds/i]) || "larger than 13-inch Air, still in the Air line"
  }),
  option({
    scenario: "Higher-headroom option",
    productName: "14-inch MacBook Pro",
    officialUrl: pages.find((page) => /buy-mac\/macbook-pro/i.test(page.url))?.url || "https://www.apple.com/us/shop/buy-mac/macbook-pro",
    sourceText: `${proText}\n${compareText}`,
    priceFallback: proPrices[0] || allPrices[0],
    explicitPrice: explicitPrices.pro14,
    display: "14.2-inch Liquid Retina XDR display",
    portability: findFirst(compareText, [/Weight 3\.4 pounds/i, /3\.4 pounds/i]) || "3.4 pounds",
    pro: true
  })
];

return JSON.stringify({
  userNeed: "Remote work, many browser tabs, video calls, light photo editing, occasional travel, and several years of useful life.",
  options,
  cheapestViableOption: options[0].productName,
  bestBalancedOption: options[1].productName,
  bestLongTermOption: options[2].productName,
  rejectedOptionsOrCaveats: [
    "Avoid base configurations below the requested memory/storage floor if available configurator choices show less than 16GB memory or 512GB storage.",
    "Avoid paying for Pro headroom unless ports, display, or sustained performance justify the extra cost."
  ],
  buyingChecklist: [
    "Verify final configured price before adding to bag.",
    "Confirm memory and storage meet at least 16GB and 512GB.",
    "Check ports and external-display needs before choosing Air versus Pro.",
    "Compare AppleCare and education/store discounts if applicable."
  ],
  sources: pages.map((page) => page.url),
  invariantPassed: options.length === 3 &&
    options.every((entry) => entry.productName && entry.officialUrl) &&
    options[0].visibleStartingPrice === "$1099" &&
    options[1].visibleStartingPrice === "$1299" &&
    options[2].visibleStartingPrice === "$1699"
});
