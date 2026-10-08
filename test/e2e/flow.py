"""Browser end-to-end: landing -> sign up -> onboarding -> live run -> dashboard pages -> reload -> sign out/in.
Runs against a real server with Postgres (npm run dev with DATABASE_URL); only the AI endpoints are mocked.
    pip install playwright && python3 test/e2e/flow.py /tmp/shots        # BASE=http://127.0.0.1:3000 by default
    W=390 H=844 python3 test/e2e/flow.py /tmp/shots-mobile"""
import json, sys, time, pathlib, http.server, threading, functools, os
from playwright.sync_api import sync_playwright

OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/claude-0/shots"); OUT.mkdir(parents=True, exist_ok=True)
W = int(os.environ.get("W", "1440")); H = int(os.environ.get("H", "900"))

BASE = os.environ.get("BASE", "http://127.0.0.1:3000")
EMAIL = f"e2e{int(time.time()*1000)}{os.getpid()}@example.com"

def sse(events):
    return "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in events)

RIVALS = ["Deloitte", "Accenture", "IBM", "McKinsey", "BCG"]
PROFILE = {"name": "Aixccelerate", "site": "https://aixccelerate.com", "category": "ai implementation partner", "offer": "Enterprise AI execution partner that helps organisations design, prove, deploy and scale role-based AI systems.",
           "audience": "CIOs and heads of digital", "market": "United States", "competitors": RIVALS, "facts": ["Founded in 2021", "Offices in Austin and Bangalore", "30+ enterprise deployments"],
           "identity": ["Agnostic by design", "Outcomes-focused", "Proof before commitment"], "products": ["AI strategy", "Forward deployment", "AI readiness assessment", "Fractional AI leadership"],
           "personas": ["Chief Information Officer", "Chief AI Officer", "VP of Digital Transformation"]}
AUDIT = {"origin": "https://aixccelerate.com", "bots": {"GPTBot": True, "PerplexityBot": True, "ClaudeBot": False}, "llms": False, "sitemap": 42, "avg": 58, "homeSchema": [], "orgSchema": False, "faqSchema": False,
         "pages": [{"url": "https://aixccelerate.com/", "title": "Home", "score": 52, "fails": ["No FAQ", "Thin intro"]}, {"url": "https://aixccelerate.com/services", "title": "Services", "score": 64, "fails": []}]}
TOPICS = ["AI data readiness", "AI implementation services", "AI strategy consulting", "Fractional AI leadership"]
INT = ["informational", "commercial", "transactional"]

def route(route):
    req = route.request; path = "/" + req.url.split("/", 3)[3]
    body = json.loads(req.post_data or "{}") if req.method == "POST" else {}
    if path.startswith("/api/config"):
        r = route.fetch(); d = r.json(); d.update({"engines": ["chatgpt", "gemini", "aio"], "llm": True, "serp": True})
        return route.fulfill(json=d)
    if path.startswith("/api/entity"):
        return route.fulfill(json={"ok": True, "score": 40, "checks": [{"label": "Wikidata item", "pass": False, "why": "No Wikidata entry found"}, {"label": "Google Knowledge Graph", "pass": True, "why": "Found as Organization"}, {"label": "sameAs links", "pass": False, "why": "Organization schema has no sameAs"}]})
    if path.startswith("/api/serp/organic"):
        return route.fulfill(json={"ok": True, "results": [{"query": q, "rank": (i % 3 == 0) and (i + 3) or None, "top": [{"domain": "deloitte.com", "url": "https://deloitte.com/x", "title": "Deloitte AI"}]} for i, q in enumerate(body.get("queries", []))]})
    if path.startswith("/api/site"):
        ev = []
        for i, (k, t) in enumerate([("robots", "Checking robots.txt for AI crawlers"), ("llms", "Looking for llms.txt"), ("sitemap", "Reading the sitemap"), ("pages", "Scoring key pages"), ("profile", "Working out what you sell")]):
            ev += [("step", {"id": k, "text": t}), ("done", {"id": k, "text": t + " ✓", "ok": True})]
        ev += [("page", p) for p in AUDIT["pages"]]
        ev.append(("result", {"profile": PROFILE, "audit": AUDIT, "siteText": "Aixccelerate helps enterprises deploy AI."}))
        return route.fulfill(status=200, headers={"content-type": "text/event-stream"}, body=sse(ev))
    if path.startswith("/api/write"):
        k = body.get("kind"); d = body.get("data", {})
        if k == "topics": txt = "\n".join(TOPICS if not d.get("exclude") else ["AI workforce training"])
        elif k == "topicQuestions":
            per = d.get("perTopic", 3); lines = []
            for t in d["topics"]:
                for j in range(per):
                    lines.append(f"{t} | {INT[(j + len(t)) % 3]} | {PROFILE['personas'][j % 3]} | Which firm is best for {t.lower()} for a {['mid-size bank', 'retailer', 'healthcare group', 'manufacturer', 'insurer'][j % 5]} in {j + 2026}?")
            txt = "\n".join(lines)
        elif k == "insights": txt = "- **Deloitte owns the lists.** It appears on 6 of the 9 pages AI cited.\n- **You're invisible on Perplexity.** 0 of 8 answers.\n- **Cheapest gap:** get onto the Clutch top-10 list.\n- **Pattern:** comparison prompts favour big consultancies.\n- **This week:** pitch darwinapps.com."
        elif k == "perception": txt = json.dumps({"summary": "AI knows Aixccelerate as a small AI consultancy but gets its location wrong.", "recognised": True, "claims": [{"claim": "Based in London", "verdict": "wrong", "fix": "State HQ in Austin on the about page"}, {"claim": "Offers AI strategy", "verdict": "accurate", "fix": "Keep"}]})
        elif k == "assets": txt = json.dumps({"llms_txt": "# Aixccelerate\n> Enterprise AI partner", "org_schema": {"@context": "https://schema.org", "@type": "Organization", "name": "Aixccelerate"}})
        elif k == "sentiment":
            txt = json.dumps({it["id"]: {b: 55 + (abs(hash(b + it["id"])) % 40) for b in it["brands"]} for it in d["items"]})
        elif k == "pitch": txt = "Subject: A missing partner for your list\n\nHi there, ..."
        else: txt = "Start with the Clutch list. It's cited 4 times and Deloitte is on it."
        return route.fulfill(status=200, headers={"content-type": "text/event-stream"}, body=sse([("delta", {"text": txt}), ("final", {"text": txt})]))
    if path.startswith("/api/ask"):
        q = body.get("question", ""); e = body.get("engine"); h = abs(hash(q + e))
        if e == "aio" and h % 4 == 0:
            return route.fulfill(status=200, headers={"content-type": "text/event-stream"}, body=sse([("final", {"answer": "", "sources": [], "brands": [], "present": False, "model": "google-aio"})]))
        brands = RIVALS[h % 3:] [:4]
        if h % 3 == 0: brands.insert(1 + h % 2, "Aixccelerate")
        doms = ["mckinsey.com", "darwinapps.com", "clutch.co", "reddit.com", "deloitte.com", "vizologi.com", "wikipedia.org", "g2.com"]
        srcs = [{"url": f"https://{doms[(h + i) % len(doms)]}/best-ai-partners-{i}", "title": f"Best AI implementation partners {2026} ({i})", "cited": i < 2} for i in range(4)]
        ans = f"Here are strong options:\n\n1. **{brands[0]}** for large programmes.\n2. **{brands[1]}** if you want speed.\n3. {', '.join(brands[2:])} are also worth a look.\n\nMy pick: {brands[0]}."
        ev = [("status", {"text": "Searching the web"}), ("search", {"query": q[:40] + " 2026"})] + [("source", s) for s in srcs] + [("delta", {"text": ans}), ("final", {"answer": ans, "sources": srcs, "brands": brands, "model": "gpt-5" if e == "chatgpt" else "gemini-2.5"})]
        return route.fulfill(status=200, headers={"content-type": "text/event-stream"}, body=sse(ev))
    if path.startswith("/api/inspect"):
        u = body["url"]; h = abs(hash(u))
        return route.fulfill(json={"ok": True, "url": u, "final": u, "domain": u.split("/")[2], "title": "Top AI implementation partners", "you": h % 5 == 0, "rivals": RIVALS[h % 3: h % 3 + 2], "evidence": [], "contacts": {"emails": ["editor@" + u.split("/")[2]]}, "excerpt": "..."})
    if path.startswith("/api/ask") or path.startswith("/api/site") or path.startswith("/api/write") or path.startswith("/api/inspect"): return route.abort()
    return route.continue_()

errors = []
SKIP = ("404", "favicon")
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": W, "height": H})
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    pg.on("console", lambda m: m.type in ("error", "warning") and errors.append(m.type + ": " + m.text))
    pg.route(lambda u: "/api/" in u and any(k in u for k in ("/api/config", "/api/site", "/api/write", "/api/ask", "/api/inspect", "/api/entity", "/api/serp/")), route)
    D3 = os.environ.get("D3_PATH")  # offline sandboxes: serve a local d3.min.js instead of the CDN
    if D3: ctx.route("https://cdnjs.cloudflare.com/**", lambda r: r.fulfill(status=200, path=D3, headers={"content-type": "text/javascript"}))
    ctx.route("https://www.google.com/**", lambda r: r.fulfill(status=404, body=""))
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", headers={"content-type": "text/css"}))
    pg.goto(BASE + "/")
    shot = lambda n: pg.screenshot(path=str(OUT / f"{n}.png"))
    time.sleep(0.6); shot("00_landing")
    pg.fill("#startUrl", "aixccelerate.com"); pg.click("#startForm button")
    pg.wait_for_selector("#auth:not([hidden])", timeout=5000); time.sleep(0.3); shot("01_auth")
    pg.fill("#authName", "Sam"); pg.fill("#authEmail", EMAIL); pg.fill("#authPass", "correct-horse-9"); pg.click("#authGo")
    pg.wait_for_selector("#obSheet:not([hidden])", timeout=10000); time.sleep(0.5); shot("02_profile_sheet")
    pg.click("[data-act=profileOk]"); time.sleep(0.3); shot("03_market")
    pg.click("#onboard form.pill .go"); time.sleep(0.3); shot("04_rivals")
    pg.fill("#obAdd-rival", "PwC"); pg.press("#obAdd-rival", "Enter"); time.sleep(0.2)
    pg.click("[data-go=topicsGen]"); pg.wait_for_selector("text=Review your topics", timeout=5000); time.sleep(0.3); shot("05_topics")
    pg.click("[data-go=focus]"); time.sleep(0.2); pg.click("[data-act=openFocus]"); time.sleep(0.4)
    if pg.query_selector("[data-samples='2']"): pg.click("[data-samples='2']")
    shot("06_focus_sheet")
    pg.click("[data-focus=compare]"); pg.click("[data-act=genPrompts]")
    pg.wait_for_selector("text=Your prompt set is ready", timeout=5000); time.sleep(0.3); shot("07_prompts_ready")
    pg.click("[data-act=openReview]"); time.sleep(0.4); shot("08_review_sheet")
    pg.click(".ob-sheet-foot [data-act=launch]")
    time.sleep(0.6); shot("09_running")
    time.sleep(2.5); shot("09b_running")
    pg.click("[data-run=watch]"); time.sleep(4); shot("09c_mission_console")
    back = pg.query_selector("#mission [data-act=stage], #missionBack, #mission .back")
    print("mission visible:", pg.evaluate("!document.querySelector('#mission').hidden"))
    pg.wait_for_selector("#ready[data-mode=done]:not([hidden])", timeout=120000); time.sleep(1.2); shot("10_ready")
    pg.click("#readyGo"); time.sleep(1.2); shot("11_overview")
    pg.screenshot(path=str(OUT / "11b_overview_full.png"), full_page=True)
    if W < 800:
        b.close(); print("ERRORS:", [e for e in errors if not any(s in e for s in SKIP)] or "none"); sys.exit()
    for page in ["prompts", "gaps", "chats", "domains", "gap", "rankings", "insights", "perception", "actions", "ranking", "site", "fanouts", "settings"]:
        pg.click(f'#side [data-page="{page}"]'); time.sleep(0.6); shot(f"12_{page}")
        if page in ("domains", "site", "settings", "gaps", "rankings"): pg.screenshot(path=str(OUT / f"12_{page}_full.png"), full_page=True)
    pg.click('#side [data-page="domains"]'); time.sleep(0.3)
    if pg.query_selector("[data-srcview=urls]"): pg.click("[data-srcview=urls]"); time.sleep(0.4); shot("12_domains_urls")
    pg.click('#side [data-page="overview"]'); time.sleep(0.3)
    if pg.query_selector("[data-howto]"): pg.click("[data-howto]"); time.sleep(0.3); shot("16_howto"); pg.keyboard.press("Escape")
    pg.click('#side [data-page="chats"]'); time.sleep(0.2); pg.click("tr[data-chat]"); time.sleep(0.4); shot("13_chat_modal")
    pg.keyboard.press("Escape"); time.sleep(0.2)
    # the run is on the server now: a fresh tab with the same session lands on this brand's dashboard
    time.sleep(5)
    pg2 = ctx.new_page(); pg2.on("pageerror", lambda e: errors.append("PAGEERROR2 " + str(e)))
    pg2.route(lambda u: "/api/config" in u, route)
    pg2.goto(BASE + "/"); time.sleep(2.5); pg2.screenshot(path=str(OUT / "17_reload.png"))
    print("reload screen:", pg2.evaluate("[...document.querySelectorAll('body > section, body > main, body > div')].filter(e=>!e.hidden).map(e=>e.id).join(',')"))
    print("runs on server:", pg2.evaluate("fetch('/api/workspaces').then(r=>r.json()).then(d=>JSON.stringify(d.workspaces.map(w=>[w.slug,w.samples,(w.trend||[]).length])))"))
    # sign out -> landing; sign in -> back to brand
    pg2.click("#signOut"); time.sleep(1); pg2.screenshot(path=str(OUT / "18_signed_out.png"))
    print("after sign out:", pg2.evaluate("[...document.querySelectorAll('body > section, body > main, body > div')].filter(e=>!e.hidden).map(e=>e.id).join(',')"))
    pg2.click("#lpAuth"); pg2.wait_for_selector("#auth:not([hidden])"); pg2.fill("#authEmail", EMAIL); pg2.fill("#authPass", "correct-horse-9"); pg2.click("#authGo")
    pg2.wait_for_selector("#reportWrap:not([hidden])", timeout=15000); time.sleep(1); pg2.screenshot(path=str(OUT / "19_signed_in_again.png"))
    print("after sign in:", pg2.evaluate("[...document.querySelectorAll('body > section, body > main, body > div')].filter(e=>!e.hidden).map(e=>e.id).join(',')"))
    pg2.goto(BASE + "/"); time.sleep(0.5)
    # landing for a signed-in user shows their brands when they come back to it
    pg2.wait_for_selector("#reportWrap:not([hidden])", timeout=15000); pg2.click("#side :text('New brand')")
    time.sleep(1.2); pg2.screenshot(path=str(OUT / "20_landing_signed_in.png"))
    b.close()
print("ERRORS:", [e for e in errors if not any(s in e for s in SKIP)] or "none")
