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

function normalizePrice(price) {
  const match = String(price ?? "").match(/\$([0-9][0-9,]*(?:\.\d{2})?)/);
  return match ? `$${match[1].replace(/,/g, "")}` : "unknown";
}

function proved(text, pattern, value) {
  return pattern.test(text) ? value : "unknown";
}

function firstKnown(...values) {
  return values.find((value) => value && value !== "unknown") || "unknown";
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

function option(config) {
  const startingPrice = normalizePrice(config.explicitPrice || config.priceFallback);
  const evidence = unique(config.evidence.filter((item) => item && item !== "unknown")).slice(0, 4);
  return {
    scenario: config.scenario,
    productName: config.productName,
    officialUrl: config.officialUrl,
    visibleStartingPrice: startingPrice,
    configuredOrRelevantPrice: startingPrice,
    chip: config.chip,
    memory: config.memory,
    storage: config.storage,
    display: config.display,
    weightOrPortability: config.portability,
    batteryOrPowerClaim: config.battery,
    portsOrExternalDisplayNotes: config.ports,
    upgradeTradeoffs: config.upgradeTradeoffs,
    whyGoodForUser: config.pro
      ? "Best fit when sustained performance, ports, display quality, and longer useful life matter more than minimum cost."
      : "Best fit when portability, battery life, quiet everyday work, and cost control matter most.",
    whyRiskyOrOverkill: config.pro
      ? "Likely overkill if the user mainly does browser work, video calls, documents, and light photo edits."
      : "May be limiting for heavier creative work, sustained external-display use, or workflows needing more ports.",
    evidence
  };
}

const airFactsText = `${airText}\n${airShopText}\n${compareText}`;
const proFactsText = `${proText}\n${proShopText}\n${compareText}`;
const airChip = proved(airFactsText, /\bM5\b/i, "M5 chip");
const proChip = proved(proFactsText, /\bM5\b/i, "M5 chip");
const airMemory = proved(airFactsText, /16GB[^.]{0,80}(unified )?memory|(unified )?memory[^.]{0,80}16GB/i, "16GB unified memory");
const proMemory = proved(proFactsText, /16GB[^.]{0,80}(unified )?memory|(unified )?memory[^.]{0,80}16GB/i, "16GB unified memory");
const airStorage = proved(airFactsText, /512GB[^.]{0,80}(SSD|storage)|(SSD|storage)[^.]{0,80}512GB/i, "512GB storage option visible");
const proStorage = proved(proFactsText, /512GB[^.]{0,80}(SSD|storage)|(SSD|storage)[^.]{0,80}512GB/i, "512GB SSD storage");
const airPorts = firstKnown(
  proved(airFactsText, /MagSafe/i, "MagSafe and Thunderbolt ports"),
  proved(airFactsText, /Thunderbolt/i, "Thunderbolt ports")
);
const proPorts = firstKnown(
  proved(proFactsText, /HDMI/i, "Thunderbolt, HDMI, and SDXC card slot"),
  proved(proFactsText, /Thunderbolt/i, "Thunderbolt ports")
);

const options = [
  option({
    scenario: "Portable value option",
    productName: "13-inch MacBook Air",
    officialUrl: pages.find((page) => /buy-mac\/macbook-air/i.test(page.url))?.url || "https://www.apple.com/us/shop/buy-mac/macbook-air",
    priceFallback: airPrices[0] || allPrices[0],
    explicitPrice: explicitPrices.air13,
    chip: airChip,
    memory: airMemory,
    storage: airStorage,
    display: proved(airFactsText, /13\.6|Liquid Retina/i, "13.6-inch Liquid Retina display"),
    portability: proved(compareText, /2\.7 pounds/i, "2.7 pounds"),
    battery: proved(airFactsText, /up to 18 hours|18 hours/i, "Up to 18 hours battery life"),
    ports: airPorts,
    upgradeTradeoffs: "512GB storage raises price versus base storage.",
    evidence: [
      normalizePrice(explicitPrices.air13) !== "unknown" ? `13-inch MacBook Air from ${normalizePrice(explicitPrices.air13)}` : "unknown",
      airChip !== "unknown" ? "MacBook Air page shows M5" : "unknown",
      airMemory,
      airStorage,
      airPorts
    ]
  }),
  option({
    scenario: "Larger-screen Air option",
    productName: "15-inch MacBook Air",
    officialUrl: pages.find((page) => /buy-mac\/macbook-air/i.test(page.url))?.url || "https://www.apple.com/us/shop/buy-mac/macbook-air",
    priceFallback: airPrices[1] || airPrices[0] || allPrices[0],
    explicitPrice: explicitPrices.air15,
    chip: airChip,
    memory: airMemory,
    storage: airStorage,
    display: proved(airFactsText, /15\.3|Liquid Retina/i, "15.3-inch Liquid Retina display"),
    portability: proved(compareText, /3\.3 pounds/i, "3.3 pounds"),
    battery: proved(airFactsText, /up to 18 hours|18 hours/i, "Up to 18 hours battery life"),
    ports: airPorts,
    upgradeTradeoffs: "Larger screen costs more than 13-inch Air at the same memory/storage floor.",
    evidence: [
      normalizePrice(explicitPrices.air15) !== "unknown" ? `15-inch MacBook Air from ${normalizePrice(explicitPrices.air15)}` : "unknown",
      airChip !== "unknown" ? "MacBook Air page shows M5" : "unknown",
      airMemory,
      airStorage,
      proved(compareText, /3\.3 pounds/i, "15-inch Air listed at 3.3 pounds")
    ]
  }),
  option({
    scenario: "Higher-headroom option",
    productName: "14-inch MacBook Pro",
    officialUrl: pages.find((page) => /buy-mac\/macbook-pro/i.test(page.url))?.url || "https://www.apple.com/us/shop/buy-mac/macbook-pro",
    priceFallback: proPrices[0] || allPrices[0],
    explicitPrice: explicitPrices.pro14,
    chip: proChip,
    memory: proMemory,
    storage: proStorage,
    display: proved(proFactsText, /Liquid Retina XDR|14\.2/i, "14.2-inch Liquid Retina XDR display"),
    portability: proved(compareText, /3\.4 pounds/i, "3.4 pounds"),
    battery: proved(proFactsText, /up to 24 hours|24 hours/i, "Up to 24 hours battery life"),
    ports: proPorts,
    upgradeTradeoffs: "Higher starting price buys Pro display, ports, and more performance headroom.",
    evidence: [
      normalizePrice(explicitPrices.pro14) !== "unknown" ? `14-inch MacBook Pro from ${normalizePrice(explicitPrices.pro14)}` : "unknown",
      proChip !== "unknown" ? "MacBook Pro page shows M5" : "unknown",
      proStorage,
      proPorts
    ],
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
    options.every((entry) => entry.evidence.length >= 2) &&
    options.every((entry) => !["chip", "memory", "storage"].some((key) => entry[key] === "unknown")) &&
    options[0].visibleStartingPrice === "$1099" &&
    options[1].visibleStartingPrice === "$1299" &&
    options[2].visibleStartingPrice === "$1699"
});
