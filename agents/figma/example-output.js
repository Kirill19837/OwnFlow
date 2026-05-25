async function createDesign() {
  const page = figma.currentPage;

  // Load all font variants FIRST — mandatory before ANY createText()
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Bold" });

  const C = {
    primary:   { r: 0.2,  g: 0.4,  b: 0.8  },
    secondary: { r: 0.1,  g: 0.2,  b: 0.55 },
    accent:    { r: 1.0,  g: 0.4,  b: 0.15 },
    bg:        { r: 0.95, g: 0.95, b: 0.97 },
    card:      { r: 0.97, g: 0.97, b: 1.0  },
    text:      { r: 0.1,  g: 0.1,  b: 0.1  },
    muted:     { r: 0.5,  g: 0.5,  b: 0.55 },
    white:     { r: 1,    g: 1,    b: 1    },
    dark:      { r: 0.08, g: 0.08, b: 0.12 },
  };

  // ─── helpers ───────────────────────────────────────────────────────────────

  function makeFrame(name, w, h, fill, parent) {
    const f = figma.createFrame();
    f.name = name;
    f.resize(w, h);           // ← resize(), not .width / .height
    f.fills = [{ type: "SOLID", color: fill }];
    if (parent) parent.appendChild(f);
    return f;
  }

  function makeRect(name, w, h, fill, rx, parent) {
    const r = figma.createRectangle();
    r.name = name;
    r.resize(w, h);
    r.fills = [{ type: "SOLID", color: fill }];
    if (rx) r.cornerRadius = rx;
    if (parent) parent.appendChild(r);
    return r;
  }

  function makeText(chars, size, bold, color, parent) {
    const t = figma.createText();
    t.fontName = { family: "Inter", style: bold ? "Bold" : "Regular" };
    t.fontSize = size;
    t.characters = chars;
    t.fills = [{ type: "SOLID", color }];
    if (parent) parent.appendChild(t);
    return t;
  }

  function pos(node, x, y) { node.x = x; node.y = y; return node; }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DESKTOP  1920 × 3000
  // ═══════════════════════════════════════════════════════════════════════════

  const desk = makeFrame("🖥  Desktop — 1920px", 1920, 3000, C.bg, page);

  // ── Nav bar ──────────────────────────────────────────────────────────────
  const nav = makeFrame("Nav Bar", 1920, 80, C.primary, desk);
  pos(makeText("⬡  GAME STORE", 26, true, C.white, nav), 48, 24);
  const navLinks = ["Home", "Games", "Deals", "Reviews", "Account"];
  navLinks.forEach((lbl, i) => pos(makeText(lbl, 15, false, C.white, nav), 700 + i * 120, 30));
  // Search box placeholder
  const searchBox = makeRect("Search box", 280, 40, { r: 1, g: 1, b: 1, a: 0.15 }, 8, nav);
  pos(searchBox, 1560, 20);
  pos(makeText("🔍  Search games…", 13, false, { r: 0.8, g: 0.8, b: 1 }, nav), 1572, 32);

  // ── Hero / Slider ────────────────────────────────────────────────────────
  const hero = makeFrame("Hero — Featured Slider", 1920, 520, C.secondary, desk);
  hero.y = 80;

  // Slide background tint
  makeRect("Slide BG", 1920, 520, { r: 0.05, g: 0.1, b: 0.3 }, 0, hero);

  // Left text block
  pos(makeText("FEATURED RELEASE", 13, false, { r: 0.6, g: 0.8, b: 1 }, hero), 100, 120);
  pos(makeText("Cyber Odyssey 2049", 56, true, C.white, hero), 100, 148);
  pos(makeText("Open-world RPG  •  PS5 / XSX / PC", 18, false, { r: 0.75, g: 0.85, b: 1 }, hero), 100, 220);

  const ctaBtn = makeRect("CTA Button", 180, 52, C.accent, 10, hero);
  pos(ctaBtn, 100, 270);
  pos(makeText("Buy Now  $59.99", 16, true, C.white, hero), 120, 283);

  // Slider dots
  [0, 1, 2, 3].forEach(i => {
    const dot = makeRect(`Dot ${i}`, i === 0 ? 28 : 10, 10, i === 0 ? C.white : { r: 0.5, g: 0.6, b: 0.9 }, 5, hero);
    pos(dot, 100 + i * 22, 470);
  });

  // Slide image placeholder (right side)
  const slideImg = makeRect("[ Game Cover Image ]", 680, 460, C.primary, 16, hero);
  pos(slideImg, 1150, 30);
  pos(makeText("[ Cover Art ]", 20, false, { r: 0.6, g: 0.8, b: 1 }, hero), 1440, 240);

  // Arrow buttons
  const prevArrow = makeRect("◀ Prev", 52, 52, { r: 0.15, g: 0.25, b: 0.6 }, 26, hero);
  pos(prevArrow, 28, 234);
  pos(makeText("◀", 18, true, C.white, hero), 39, 246);

  const nextArrow = makeRect("▶ Next", 52, 52, { r: 0.15, g: 0.25, b: 0.6 }, 26, hero);
  pos(nextArrow, 1840, 234);
  pos(makeText("▶", 18, true, C.white, hero), 1851, 246);

  // ── Featured Games Grid ──────────────────────────────────────────────────
  const featuredSection = makeFrame("Featured Games", 1920, 680, C.white, desk);
  featuredSection.y = 600;

  pos(makeText("Featured Games", 32, true, C.text, featuredSection), 100, 48);
  pos(makeText("Hand-picked titles for you", 16, false, C.muted, featuredSection), 100, 92);

  const gameData = [
    { title: "Cyber Odyssey 2049", genre: "RPG", price: "$59.99", tag: "NEW" },
    { title: "Shadow Realms",      genre: "Action", price: "$49.99", tag: "HOT" },
    { title: "Pixel Raiders",      genre: "Indie",  price: "$19.99", tag: "SALE" },
    { title: "Space Commander",    genre: "Strategy", price: "$39.99", tag: "" },
  ];

  gameData.forEach((g, i) => {
    const cx = 100 + i * 440;
    const card = makeFrame(`Game Card — ${g.title}`, 400, 500, C.card, featuredSection);
    card.cornerRadius = 12;
    pos(card, cx, 130);

    // Game image placeholder
    const img = makeRect("[ Thumbnail ]", 400, 280, C.primary, 0, card);
    img.topLeftRadius = 12; img.topRightRadius = 12;
    pos(makeText("[ Cover Art ]", 14, false, { r: 0.6, g: 0.8, b: 1 }, card), 155, 130);

    // Tag badge
    if (g.tag) {
      const badge = makeRect(g.tag, 52, 24, C.accent, 6, card);
      pos(badge, 332, 10);
      pos(makeText(g.tag, 11, true, C.white, card), 339, 15);
    }

    pos(makeText(g.title, 18, true, C.text, card), 16, 298);
    pos(makeText(g.genre, 13, false, C.muted, card), 16, 326);
    pos(makeText(g.price, 20, true, C.accent, card), 16, 356);

    const addBtn = makeRect("Add to cart", 170, 44, C.primary, 8, card);
    pos(addBtn, 16, 434);
    pos(makeText("Add to Cart", 14, true, C.white, card), 43, 445);
  });

  // ── Promotions Banner ────────────────────────────────────────────────────
  const promoSection = makeFrame("Promotions", 1920, 360, C.secondary, desk);
  promoSection.y = 1280;

  pos(makeText("🔥  Limited-Time Deals", 36, true, C.white, promoSection), 100, 50);

  const promos = [
    { label: "WEEKEND FLASH SALE",  sub: "Up to 60% off Action RPGs",   clr: { r: 0.8, g: 0.2, b: 0.1 } },
    { label: "PRE-ORDER BONUS",     sub: "Free DLC with every pre-order", clr: { r: 0.1, g: 0.5, b: 0.3 } },
    { label: "BUNDLE DEAL",         sub: "3 games for the price of 2",   clr: C.accent },
  ];

  promos.forEach((p, i) => {
    const card = makeFrame(`Promo — ${p.label}`, 530, 200, p.clr, promoSection);
    card.cornerRadius = 14;
    pos(card, 100 + i * 590, 120);
    pos(makeText(p.label, 20, true, C.white, card), 24, 30);
    pos(makeText(p.sub, 14, false, C.white, card), 24, 70);
    const shopBtn = makeRect("Shop Now", 120, 36, { r:1,g:1,b:1,a:0.2 }, 8, card);
    pos(shopBtn, 24, 130);
    pos(makeText("Shop Now →", 13, true, C.white, card), 34, 140);
  });

  // ── Customer Reviews ─────────────────────────────────────────────────────
  const reviewSection = makeFrame("Customer Reviews", 1920, 500, C.bg, desk);
  reviewSection.y = 1640;

  pos(makeText("What Players Are Saying", 32, true, C.text, reviewSection), 100, 48);
  pos(makeText("Verified reviews from our community", 16, false, C.muted, reviewSection), 100, 92);

  const reviews = [
    { name: "Alex M.",    stars: 5, text: "Incredible selection!\nFast delivery too." },
    { name: "Priya K.",   stars: 5, text: "Best prices I found\nanywhere online." },
    { name: "Tom W.",     stars: 4, text: "Great UX and easy\ncheckout process." },
  ];

  reviews.forEach((r, i) => {
    const card = makeFrame(`Review — ${r.name}`, 540, 260, C.white, reviewSection);
    card.cornerRadius = 12;
    pos(card, 100 + i * 590, 130);
    pos(makeText("★".repeat(r.stars) + "☆".repeat(5 - r.stars), 22, true, C.accent, card), 24, 24);
    pos(makeText(`"${r.text}"`, 15, false, C.text, card), 24, 72);
    pos(makeText(`— ${r.name}`, 13, false, C.muted, card), 24, 190);
  });

  // ── Footer ───────────────────────────────────────────────────────────────
  const footer = makeFrame("Footer", 1920, 160, C.dark, desk);
  footer.y = 2840;
  pos(makeText("© 2024 Game Store. All rights reserved.", 14, false, C.white, footer), 100, 70);
  pos(makeText("Privacy Policy  |  Terms  |  Support  |  Careers", 13, false, { r:0.55,g:0.6,b:0.7 }, footer), 1400, 70);

  // ═══════════════════════════════════════════════════════════════════════════
  //  MOBILE  375 × 2600
  // ═══════════════════════════════════════════════════════════════════════════

  const mob = makeFrame("📱  Mobile — 375px", 375, 2600, C.bg, page);
  mob.x = 2100;

  // ── Mobile Nav ───────────────────────────────────────────────────────────
  const mobNav = makeFrame("Nav", 375, 64, C.primary, mob);
  pos(makeText("⬡ GAME STORE", 18, true, C.white, mobNav), 16, 20);
  // Hamburger icon placeholder
  pos(makeText("☰", 22, true, C.white, mobNav), 332, 18);

  // ── Mobile Hero ──────────────────────────────────────────────────────────
  const mobHero = makeFrame("Hero Slider", 375, 280, C.secondary, mob);
  mobHero.y = 64;
  makeRect("[ Hero Cover ]", 375, 280, { r: 0.05, g: 0.1, b: 0.3 }, 0, mobHero);
  pos(makeText("FEATURED", 11, true, { r: 0.6, g: 0.8, b: 1 }, mobHero), 16, 80);
  pos(makeText("Cyber Odyssey\n2049", 28, true, C.white, mobHero), 16, 100);
  pos(makeText("Buy Now  $59.99", 14, true, C.white, mobHero), 16, 200);
  const mobCta = makeRect("CTA", 150, 40, C.accent, 8, mobHero);
  pos(mobCta, 16, 220);
  pos(makeText("Buy Now  $59.99", 13, true, C.white, mobHero), 26, 231);
  // Dots
  [0,1,2].forEach(i => {
    const d = makeRect(`dot-${i}`, i===0?20:8, 8, i===0?C.white:{r:0.5,g:0.6,b:0.9}, 4, mobHero);
    pos(d, 16 + i*18, 258);
  });

  // ── Mobile Game Cards (stacked) ──────────────────────────────────────────
  const mobGames = makeFrame("Game Cards", 375, 1180, C.white, mob);
  mobGames.y = 344;
  pos(makeText("Featured Games", 20, true, C.text, mobGames), 16, 20);

  gameData.forEach((g, i) => {
    const card = makeFrame(`Card — ${g.title}`, 343, 240, C.card, mobGames);
    card.cornerRadius = 10;
    pos(card, 16, 60 + i * 270);

    const img = makeRect("[ Cover ]", 140, 210, C.primary, 0, card);
    img.topLeftRadius = 10; img.bottomLeftRadius = 10;

    if (g.tag) {
      const badge = makeRect(g.tag, 46, 20, C.accent, 4, card);
      pos(badge, 150, 8);
      pos(makeText(g.tag, 10, true, C.white, card), 157, 11);
    }
    pos(makeText(g.title, 15, true, C.text, card), 154, 30);
    pos(makeText(g.genre, 12, false, C.muted, card), 154, 58);
    pos(makeText(g.price, 18, true, C.accent, card), 154, 90);
    const addBtn = makeRect("Add", 140, 36, C.primary, 6, card);
    pos(addBtn, 154, 160);
    pos(makeText("Add to Cart", 12, true, C.white, card), 176, 170);
  });

  // ── Mobile Promotions ────────────────────────────────────────────────────
  const mobPromo = makeFrame("Promotions", 375, 340, C.secondary, mob);
  mobPromo.y = 1524;
  pos(makeText("🔥 Deals", 20, true, C.white, mobPromo), 16, 20);

  promos.forEach((p, i) => {
    const card = makeFrame(`Promo ${i}`, 343, 80, p.clr, mobPromo);
    card.cornerRadius = 10;
    pos(card, 16, 60 + i * 94);
    pos(makeText(p.label, 14, true, C.white, card), 14, 14);
    pos(makeText(p.sub, 11, false, C.white, card), 14, 40);
  });

  // ── Mobile Reviews ───────────────────────────────────────────────────────
  const mobReviews = makeFrame("Reviews", 375, 460, C.white, mob);
  mobReviews.y = 1864;
  pos(makeText("Player Reviews", 20, true, C.text, mobReviews), 16, 20);

  reviews.forEach((r, i) => {
    const card = makeFrame(`Review ${i}`, 343, 120, C.card, mobReviews);
    card.cornerRadius = 10;
    pos(card, 16, 60 + i * 130);
    pos(makeText("★".repeat(r.stars), 16, true, C.accent, card), 14, 12);
    pos(makeText(`"${r.text}"`, 12, false, C.text, card), 14, 40);
    pos(makeText(`— ${r.name}`, 11, false, C.muted, card), 14, 90);
  });

  // ── Mobile Footer ────────────────────────────────────────────────────────
  const mobFooter = makeFrame("Footer", 375, 120, C.dark, mob);
  mobFooter.y = 2480;
  pos(makeText("© 2024 Game Store", 12, false, C.white, mobFooter), 16, 50);

  // ── Zoom to Desktop frame ─────────────────────────────────────────────────
  figma.currentPage.selection = [desk, mob];
  figma.viewport.scrollAndZoomIntoView([desk]);

  figma.notify("✅ Wireframes created! Desktop + Mobile views ready.", { timeout: 3000 });
}

createDesign().catch(e => {
  figma.notify("❌ Error: " + e.message, { error: true });
  console.error(e);
});
