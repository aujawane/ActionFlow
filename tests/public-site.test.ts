import "./support/react-global";

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HomePage } from "../components/public-site/home-page";
import { PrivacyPolicy, privacySections } from "../components/public-site/privacy-content";
import { TermsOfService, termsSections } from "../components/public-site/terms-content";
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_OPERATOR_NAME,
  LEGAL_EFFECTIVE_DATE,
  PUBLIC_SITE_PATHS,
  SITE_URL,
  canonicalUrl,
  isPublicSitePath
} from "../lib/public-site";
import { recoveryErrorPath } from "../lib/password-recovery";
import { authRedirectFor } from "../lib/supabase/middleware";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const exists = (path: string) => access(new URL(`../${path}`, import.meta.url)).then(() => true, () => false);
const render = (component: (props: { signedIn: boolean }) => unknown, signedIn = false) =>
  renderToStaticMarkup(createElement(component as never, { signedIn }));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ");

// ============================================================ [1] public homepage
test("[1] / renders meaningful public Parfait content for a signed-out visitor", () => {
  const html = render(HomePage);
  const body = text(html);
  assert.match(html, /<h1[^>]*>Turn meetings into action\.<\/h1>/);
  assert.match(body, /Parfait captures the commitments, tasks, decisions, and context/);
  // The hero has no eyebrow badge above the headline; the descriptor lives in the footer only.
  const hero = html.match(/<section[^>]*aria-labelledby="hero-heading"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.doesNotMatch(text(hero), /AI-powered meeting execution workspace/);
  assert.match(hero, /<div class="space-y-6"><h1/);
  assert.match(text(hero), /Owner: Craig · Due: Friday/);
  assert.doesNotMatch(body, /Priya/);
  for (const heading of ["From conversation to follow-through", "What Parfait does"]) {
    assert.ok(body.includes(heading), heading);
  }
  // Signed-out visitors get the existing auth route, not a duplicate flow.
  assert.ok(hrefs(html).includes("/login"));
  assert.match(body, /Get started/);
  assert.match(body, /Sign in/);
  assert.doesNotMatch(body, /Open Parfait/);
});

test("[2][3] the homepage links to /privacy and /terms from the header, body and footer", () => {
  const html = render(HomePage);
  const links = hrefs(html);
  assert.ok(links.filter((href) => href === "/privacy").length >= 3);
  assert.ok(links.filter((href) => href === "/terms").length >= 3);
  assert.match(html, /<nav aria-label="Primary"/);
  assert.match(html, /<nav aria-label="Footer"/);
});

test("signed-in visitors are not redirected: the homepage offers Open Parfait instead of signing up again", () => {
  const html = render(HomePage, true);
  assert.ok(hrefs(html).includes("/dashboard"));
  assert.match(text(html), /Open Parfait/);
  assert.doesNotMatch(text(html), /Get started/);
  assert.doesNotMatch(html, /href="\/login"/);
});

test("the homepage makes no unsupported claims or fake social proof", () => {
  const body = text(render(HomePage)).toLowerCase();
  for (const banned of [
    "soc 2", "soc2", "iso 27001", "hipaa", "gdpr compliant", "certified", "99.9", "guarantee",
    "100% accurate", "testimonial", "trusted by", "customers", "% faster", "enterprise-grade"
  ]) {
    assert.ok(!body.includes(banned), banned);
  }
});

// ============================================================ [4] existing auth path
test("[4] the existing login/signup flow is intact and still the target of Sign in / Get started", async () => {
  assert.ok(await exists("app/(auth)/login/page.tsx"));
  const login = await read("app/(auth)/login/page.tsx");
  assert.match(login, /<AuthForm \/>/);
  assert.match(login, /redirect\("\/dashboard"\)/);

  const form = await read("components/auth-form.tsx");
  assert.match(form, /supabase\.auth\.signInWithPassword\(\{ email, password \}\)/);
  assert.match(form, /supabase\.auth\.signUp\(\{/);
  assert.match(form, /emailRedirectTo: `\$\{window\.location\.origin\}\/api\/auth\/callback\?next=\/account`/);
  // The only change to the form is the legal notice.
  assert.match(form, /href="\/terms"/);
  assert.match(form, /href="\/privacy"/);
});

// ============================================================ [5][6][7] legal pages
test("[5] /privacy renders a Parfait-specific policy with the required sections", () => {
  const html = render(PrivacyPolicy);
  const body = text(html);
  assert.match(html, /<h1[^>]*>Privacy Policy<\/h1>/);
  assert.ok(body.includes(`Effective date: ${LEGAL_EFFECTIVE_DATE}`));
  for (const heading of [
    "Information we collect", "Google Sign In and Google User Data", "How we use information", "AI processing",
    "Service providers and who we share with", "Cookies and similar technologies", "Data retention and deletion",
    "Your choices", "Security", "Children", "Changes to this policy", "Contact"
  ]) {
    assert.ok(body.includes(heading), heading);
  }
  for (const provider of ["Supabase", "Recall.ai", "OpenAI", "Vercel", "Google"]) assert.ok(body.includes(provider), provider);
  assert.doesNotMatch(body, /lorem ipsum/i);
});

test("[6] /terms renders, including the recording-consent responsibility", () => {
  const html = render(TermsOfService);
  const body = text(html);
  assert.match(html, /<h1[^>]*>Terms of Service<\/h1>/);
  assert.ok(body.includes(`Effective date: ${LEGAL_EFFECTIVE_DATE}`));
  for (const heading of [
    "Acceptance of these terms", "Eligibility", "Your account", "Recording, transcription and consent", "Your content",
    "AI-generated output and its limits", "Acceptable use", "Third-party services", "Intellectual property",
    "Termination", "Disclaimers", "Limitation of liability", "Changes to these terms", "Contact"
  ]) {
    assert.ok(body.includes(heading), heading);
  }
  assert.match(body, /solely responsible for making sure you have the right to do so/);
  assert.match(body, /does not determine whether recording or transcribing a particular meeting is lawful/);
});

test("[7] the three public pages require no authentication", async () => {
  for (const path of PUBLIC_SITE_PATHS) assert.equal(authRedirectFor({ pathname: path, hasUser: false }), null, path);
  for (const path of PUBLIC_SITE_PATHS) assert.equal(authRedirectFor({ pathname: path, hasUser: true }), null, path);
  for (const file of ["app/page.tsx", "app/privacy/page.tsx", "app/terms/page.tsx"]) {
    const source = await read(file);
    assert.doesNotMatch(source, /requireUser|requireApiUser|redirect\(|notFound\(/, file);
    assert.match(source, /isVisitorSignedIn/, file);
  }
  // The visitor lookup can never break a public page.
  const session = await read("lib/public-site-session.ts");
  assert.match(session, /catch \{\s*return false;/);
});

// ============================================================ [8] auth behaviour unchanged
test("[8] auth routing and callback behavior are unchanged", async () => {
  const cases: Array<[string, boolean, string | null]> = [
    ["/dashboard", false, "/login"], ["/meetings/abc", false, "/login"], ["/tasks/x", false, "/login"],
    ["/account", false, "/login"], ["/login", true, "/dashboard"], ["/forgot-password", true, "/dashboard"],
    ["/login", false, null], ["/dashboard", true, null],
    ["/account/reset-password", false, recoveryErrorPath("recovery_session_required")]
  ];
  for (const [pathname, hasUser, expected] of cases) {
    assert.equal(authRedirectFor({ pathname, hasUser }), expected, `${pathname} hasUser=${hasUser}`);
  }
  const callback = await read("app/api/auth/callback/route.ts");
  assert.match(callback, /sanitizeInternalPath\(searchParams\.get\("next"\), "\/dashboard"\)/);
  assert.match(callback, /completeAuthCallback\(\{/);
  assert.match(callback, /RECOVERY_COOKIE_NAME/);
  const middleware = await read("middleware.ts");
  assert.match(middleware, /updateSession\(request\)/);
});

// ============================================================ [9] Google sign-in untouched, policy matches code
test("[9] Google sign-in still requests no extra scopes, and the policy describes sign-in only", async () => {
  const form = await read("components/auth-form.tsx");
  const oauthCall = form.match(/signInWithOAuth\(\{[\s\S]*?\n {4}\}\);/);
  assert.ok(oauthCall, "expected the signInWithOAuth call");
  assert.match(oauthCall![0], /provider: "google"/);
  assert.match(oauthCall![0], /redirectTo: `\$\{window\.location\.origin\}\/api\/auth\/callback\?next=/);
  assert.doesNotMatch(oauthCall![0], /scopes|queryParams/);

  const privacy = render(PrivacyPolicy);
  assert.match(text(privacy), /We request no additional Google API scopes for sign-in/);
  assert.match(text(privacy), /does not call any Google service APIs, and does not request access to your Gmail, Google Drive, Google Calendar, contacts or Google Meet/);
  assert.match(privacy, /Google API Services User Data Policy/);
  assert.match(text(privacy), /Limited Use requirements/);
  assert.match(text(privacy), /We do not sell Google user data/);
});

// ============================================================ policy accuracy guards
test("the policy discloses Resend narrowly and makes no claims it cannot support", () => {
  const privacy = text(render(PrivacyPolicy));
  const terms = text(render(TermsOfService));

  // Resend: SMTP for Supabase Auth emails only (operator-confirmed; not provable from source).
  assert.match(privacy, /Resend delivers transactional email for us, specifically the authentication and account emails that Supabase sends on our behalf/);
  assert.match(privacy, /It does not receive meeting transcripts, project content or AI-generated outputs/);
  assert.match(privacy, /Resend, which receives your email address only when we send you an account or security email/);
  // Every sentence that names Resend together with meeting data must be a negation.
  const resendSentences = privacy.split(/(?<=\.)\s+/).filter((sentence) => /resend/i.test(sentence));
  assert.ok(resendSentences.length >= 3);
  for (const sentence of resendSentences) {
    if (/transcript|project content|AI-generated|meeting content/i.test(sentence)) {
      assert.match(sentence, /\b(does not|do not|not)\b/i, sentence);
    }
  }

  // Analytics: source code cannot prove hosting-dashboard settings, so the policy says nothing either way.
  assert.doesNotMatch(privacy + terms, /analytics/i);
  assert.ok(!/google analytics|mixpanel|segment|hotjar/i.test(privacy + terms));
  assert.ok(!/soc 2|iso 27001|hipaa|gdpr compliant|ccpa compliant/i.test(privacy + terms));
});

test("the contact email renders in every contact spot; entity name, address and governing law are not invented", async () => {
  assert.equal(LEGAL_CONTACT_EMAIL, "support@parfait-app.com");
  const mailto = /<a href="mailto:support@parfait-app\.com"[^>]*>support@parfait-app\.com<\/a>/g;
  const privacy = render(PrivacyPolicy);
  const terms = render(TermsOfService);
  assert.equal((privacy.match(mailto) ?? []).length, 2, "privacy: Your choices + Contact");
  assert.equal((terms.match(mailto) ?? []).length, 1, "terms: Contact");
  assert.match(privacy, /For privacy and data requests, email us at/);
  assert.match(privacy, /For privacy questions and requests, email us at/);
  assert.match(terms, /For questions about these terms, email us at/);
  assert.doesNotMatch(text(privacy) + text(terms), /not yet published/);
  assert.equal(LEGAL_OPERATOR_NAME, null);
  assert.doesNotMatch(text(terms), /governing law|arbitration|jurisdiction|incorporated|registered office/i);
});

test("every table-of-contents link resolves to a headed section, and ids are unique", () => {
  for (const [component, sections] of [[PrivacyPolicy, privacySections], [TermsOfService, termsSections]] as const) {
    const html = render(component);
    const ids = sections.map((section) => section.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.ok(html.includes(`href="#${id}"`), `toc link #${id}`);
      assert.ok(html.includes(`id="${id}"`), `section #${id}`);
      assert.ok(html.includes(`id="${id}-heading"`), `heading #${id}`);
    }
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, "exactly one h1");
  }
});

// ============================================================ accessibility structure
test("each public page has a skip link, a main landmark, one h1 and labelled navigation", () => {
  for (const component of [HomePage, PrivacyPolicy, TermsOfService]) {
    const html = render(component);
    assert.match(html, /<a href="#main-content"[^>]*>Skip to content<\/a>/);
    assert.match(html, /<main id="main-content"/);
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1);
    assert.match(html, /<nav aria-label="Primary"/);
    assert.doesNotMatch(html, /<img/, "no stock imagery");
  }
});

// ============================================================ metadata
test("metadata uses the required titles and parfait-app.com canonical URLs", async () => {
  assert.equal(SITE_URL, "https://parfait-app.com");
  assert.equal(canonicalUrl("/"), "https://parfait-app.com");
  assert.equal(canonicalUrl("/privacy"), "https://parfait-app.com/privacy");
  assert.equal(canonicalUrl("/terms"), "https://parfait-app.com/terms");

  const expected: Array<[string, string]> = [
    ["app/page.tsx", "Parfait | Turn meetings into action"],
    ["app/privacy/page.tsx", "Privacy Policy | Parfait"],
    ["app/terms/page.tsx", "Terms of Service | Parfait"]
  ];
  for (const [file, title] of expected) {
    const source = await read(file);
    assert.ok(source.includes(`const title = "${title}";`), file);
    assert.match(source, /description,/);
    assert.match(source, /alternates: \{ canonical: canonicalUrl\(/);
  }
});

// ============================================================ shell and legal links in-product
test("the app shell is hidden only on the three public pages", async () => {
  for (const path of ["/", "/privacy", "/terms", "/privacy/"]) assert.equal(isPublicSitePath(path), true, path);
  for (const path of ["/login", "/dashboard", "/projects", "/meetings/new", "/account", "/privacy/x", "/api/health", "", null]) {
    assert.equal(isPublicSitePath(path), false, String(path));
  }
  const layout = await read("app/layout.tsx");
  assert.match(layout, /<AppShell headerActions=\{<AccountMenuServer \/>\}>\{children\}<\/AppShell>/);
  const shell = await read("components/app-shell.tsx");
  assert.match(shell, /isPublicSitePath\(pathname\)/);
  for (const piece of ["<SidebarNav />", "<MobileNav />", "Add Meeting"]) assert.ok(shell.includes(piece), piece);
});

test("users can reach /privacy and /terms from sign-in and account settings", async () => {
  const account = await read("components/account-settings-client.tsx");
  assert.match(account, /href="\/privacy"/);
  assert.match(account, /href="\/terms"/);
  const form = await read("components/auth-form.tsx");
  assert.match(form, /href="\/privacy"/);
  assert.match(form, /href="\/terms"/);
});

test("legal pages collapse the table of contents on small screens and keep it open on large ones", () => {
  for (const component of [PrivacyPolicy, TermsOfService]) {
    const html = render(component);
    assert.match(html, /<details class="premium-card[^"]*lg:hidden"><summary[^>]*>On this page<\/summary>/);
    assert.ok(!/<details[^>]*\sopen/.test(html), "collapsed by default");
    assert.match(html, /<nav aria-label="[^"]+ sections" class="hidden lg:sticky lg:top-6 lg:block lg:self-start">/);
  }
});

test("the shared public header offers Log in (secondary) and Sign up (primary), both to the existing /login route", () => {
  for (const component of [HomePage, PrivacyPolicy, TermsOfService]) {
    const header = render(component).match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
    const links = [...header.matchAll(/<a ([^>]*href="\/login"[^>]*)>([^<]*)<\/a>/g)];
    assert.deepEqual(links.map((m) => m[2]), ["Log in", "Sign up"]);
    assert.match(links[0][1], /border border-slate-300 bg-white\/80/, "Log in stays the outlined action");
    assert.match(links[1][1], /bg-brand-700 text-white/, "Sign up stays the primary green action");
    assert.doesNotMatch(header, /Sign in|Get started/);
  }
  // Signed-in navigation is unchanged.
  const signedIn = renderToStaticMarkup(createElement(PrivacyPolicy as never, { signedIn: true }));
  const signedInHeader = signedIn.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.match(signedInHeader, /href="\/dashboard"[^>]*>Open Parfait</);
  assert.doesNotMatch(signedInHeader, /Log in|Sign up/);
});
