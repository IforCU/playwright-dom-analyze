/**
 * core/functionalClassifier.js
 *
 * Pure Node.js heuristic classifier that assigns a human-meaningful
 * functional category to each extracted DOM node.
 *
 * INPUT  — array of node objects produced by extractStaticNodes()
 * OUTPUT — same array with added fields per node:
 *   functionalCategory           string   category key
 *   functionalCategoryCode       string   short label (BTN, NAV, …)
 *   functionalCategoryConfidence number   0.0–1.0 heuristic confidence
 *   labelColor                   string   CSS hex color for annotation
 *   categoryReason               string[] list of heuristic rules that fired
 *
 * IMPORTANT: This module only reads the serializable node metadata
 * (tagName, text, role, type, href, classList, id, group, etc.).
 * It never touches the Playwright page or DOM directly.
 *
 * CATEGORY LIST
 * ─────────────
 *  login      — login / sign-in / sign-up / auth / social login controls
 *  modal      — dialogs and overlays blocking the page
 *  search     — search inputs and search action buttons
 *  form       — form containers
 *  tab        — tab bars, accordions, expandable panels
 *  dropdown   — <select>, combobox, option lists
 *  checkbox   — checkbox, radio, toggle/switch
 *  button     — actionable buttons (non-login, non-search)
 *  nav        — navigation bars, menus, site navigation
 *  pagination — page number controls
 *  banner     — promotional banners, advertisement containers
 *  card       — repeated card / list-item containers
 *  input      — generic text/email/date/number inputs
 *  link       — anchor links (non-nav, non-login)
 *  heading    — h1–h6 headings
 *  media      — images, video, canvas, svg, iframes
 *  layout     — header, footer, sidebar, major layout regions
 *  unknown    — could not classify
 */

// ── Color + label code table ──────────────────────────────────────────────────
//
// Colors are chosen to be visually distinct at a glance on most web pages.
// All entries are stable — do NOT reorder (consumers may depend on label codes).

export const CATEGORY_META = {
  // key              code    hex-color        human label
  login:      { code: 'AUTH', color: '#DD6B20', label: 'Login / Auth'      },
  modal:      { code: 'MODAL', color: '#C05621', label: 'Modal / Dialog'   },
  search:     { code: 'SRCH', color: '#805AD5', label: 'Search'            },
  form:       { code: 'FORM', color: '#319795', label: 'Form'              },
  tab:        { code: 'TAB',  color: '#ED64A6', label: 'Tab / Accordion'   },
  dropdown:   { code: 'DROP', color: '#D69E2E', label: 'Dropdown / Select' },
  checkbox:   { code: 'CHK',  color: '#85A20E', label: 'Checkbox / Radio'  },
  button:     { code: 'BTN',  color: '#E53E3E', label: 'Button'            },
  nav:        { code: 'NAV',  color: '#3182CE', label: 'Navigation / Menu' },
  pagination: { code: 'PAGE', color: '#2A4365', label: 'Pagination'        },
  banner:     { code: 'BNR',  color: '#718096', label: 'Banner / Ad'       },
  card:       { code: 'CARD', color: '#6B4B2E', label: 'Card / List Item'  },
  input:      { code: 'INP',  color: '#38A169', label: 'Input Field'       },
  link:       { code: 'LINK', color: '#0BC5EA', label: 'Link'              },
  heading:    { code: 'HDG',  color: '#2D3748', label: 'Heading / Text'    },
  media:      { code: 'IMG',  color: '#276749', label: 'Image / Media'     },
  layout:     { code: 'LYT',  color: '#553C9A', label: 'Header / Footer'   },
  unknown:    { code: '?',    color: '#718096', label: 'Unknown'           },
};

// ── Auth / login keyword sets ─────────────────────────────────────────────────
// Korean terms use (?:^|[\s,./|]) boundaries since \b doesn't work for CJK chars.

const AUTH_TEXT_RE = /(?:^|[\s,./|(])(?:로그인|로그아웃|로그 아웃|회원가입|회원 가입|마이페이지|마이 페이지|내 정보|아이디|비밀번호|소셜 로그인)(?:$|[\s,./|)])|(?:\b(?:login|log in|log-in|logout|log out|sign in|sign-in|signin|sign up|sign-up|signup|register|account|my page|mypage|profile|member|auth|kakao|naver|apple login)\b)/i;
const AUTH_HREF_RE = /\/(login|signin|sign-in|sign_in|logout|signout|sign-out|sign_out|signup|sign-up|sign_up|register|registration|account|mypage|my-page|my_page|auth|member|oauth|sso)\b/i;
const AUTH_CLASS_RE = /\b(login|logout|signin|sign-in|signup|sign-up|auth|member|account|mypage|social-login|kakao|naver|google-login|apple-login)\b/i;
// Quick Korean-only text check (no boundary needed since we test the whole text)
const AUTH_KR_TEXT_RE = /로그인|로그아웃|회원가입|마이페이지|비밀번호|아이디|소셜 로그인/;

// ── Search keyword sets ───────────────────────────────────────────────────────

const SEARCH_TEXT_RE = /\b(search|find|찾기|조회|탐색)\b|검색/i;
const SEARCH_CLASS_RE = /\b(search|search-box|search-bar|search-btn|search-input|search-form)\b|검색/i;

// ── Navigation keyword sets ───────────────────────────────────────────────────

const NAV_CLASS_RE = /\b(nav|menu|navbar|nav-bar|navigation|breadcrumb|gnb|lnb|snb|tab-menu|side-menu|main-menu|header-menu|hamburger)\b/i;

// ── Pagination keyword sets ───────────────────────────────────────────────────

const PAGINATION_TEXT_RE = /^(다음|이전|next|prev|previous|first|last|처음|마지막|\d+)$/i;
const PAGINATION_CLASS_RE = /\b(pagination|pager|page-nav|page-number|pagenation)\b/i;

// ── Banner / ad keyword sets ──────────────────────────────────────────────────

const BANNER_CLASS_RE = /\b(banner|ad|ads|advertisement|advert|adsense|promo|promotion|sponsored|sponsor|ad-container|ad-wrap|ad-slot)\b/i;

// ── Card / list-item keyword sets ─────────────────────────────────────────────

const CARD_CLASS_RE = /\b(card|item|product|article-item|post-item|list-item|result-item|entry|tile|grid-item|news-item|blog-item|post-card|product-card)\b/i;

// ── Heading tags ──────────────────────────────────────────────────────────────

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// ── Media tags ────────────────────────────────────────────────────────────────

const MEDIA_TAGS = new Set(['img', 'video', 'canvas', 'svg', 'picture', 'iframe', 'audio', 'embed', 'object']);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Lower-case joined class + id string of a node */
function hintStr(node) {
  const cls = Array.isArray(node.classList)
    ? node.classList.join(' ')
    : (typeof node.classList === 'string' ? node.classList : '');
  return `${cls} ${node.id ?? ''}`.toLowerCase();
}

/** True when the node is plausibly interactive */
function isInteractive(node) {
  const interactiveTags = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'details']);
  if (interactiveTags.has(node.tagName)) return true;
  if (node.role && /^(button|link|menuitem|option|tab|checkbox|radio|switch|combobox|listbox|textbox|searchbox|spinbutton|slider)$/.test(node.role)) return true;
  return false;
}

// ── Core classifier ───────────────────────────────────────────────────────────

/**
 * Classify one node into a functional category.
 *
 * Returns { category, confidence, reasons }.
 *
 * Rules are evaluated in priority order.  The first matching rule wins,
 * so more specific rules (login, modal, search) appear before generic ones
 * (button, link, heading).
 */
function classifyNode(node) {
  const tag     = (node.tagName  ?? '').toLowerCase();
  const text    = (node.text     ?? '').trim();
  const role    = (node.role     ?? '').toLowerCase();
  const type    = (node.type     ?? '').toLowerCase();
  const href    = (node.href     ?? '').toLowerCase();
  const group   = (node.group   ?? '');
  const hint    = hintStr(node);
  const reasons = [];

  // ── 1. Modal / dialog (highest layout priority) ───────────────────────────
  if (
    group === 'modal-like' ||
    role === 'dialog' || role === 'alertdialog' ||
    /modal|dialog|overlay|popup|lightbox/.test(hint)
  ) {
    if (group === 'modal-like') reasons.push('group=modal-like');
    if (role === 'dialog' || role === 'alertdialog') reasons.push(`role=${role}`);
    if (/modal|dialog|overlay|popup|lightbox/.test(hint)) reasons.push('class/id=modal-keyword');
    return { category: 'modal', confidence: 0.90, reasons };
  }

  // ── 2. Login / auth (checked before generic button/link) ─────────────────
  {
    const authTextMatch  = AUTH_TEXT_RE.test(text) || AUTH_KR_TEXT_RE.test(text);
    const authHrefMatch  = href && AUTH_HREF_RE.test(href);
    const authClassMatch = AUTH_CLASS_RE.test(hint);
    const isPasswordInput = tag === 'input' && type === 'password';
    const isUsernameInput = tag === 'input' && (type === 'email' || /password|username|userid|id|아이디/.test(hint));

    if (isPasswordInput || isUsernameInput || authTextMatch || authHrefMatch || authClassMatch) {
      if (isPasswordInput)  reasons.push('type=password');
      if (isUsernameInput)  reasons.push('input=username/email/id field');
      if (authTextMatch)    reasons.push(`text includes auth keyword "${text.slice(0, 30)}"`);
      if (authHrefMatch)    reasons.push(`href matches auth pattern "${href.slice(0, 60)}"`);
      if (authClassMatch)   reasons.push('class/id=auth keyword');
      const confidence = (isPasswordInput || isUsernameInput) ? 0.97
        : authTextMatch ? 0.92
        : authHrefMatch ? 0.88
        : 0.80;
      return { category: 'login', confidence, reasons };
    }
  }

  // ── 3. Search ─────────────────────────────────────────────────────────────
  {
    const isSearchInput  = tag === 'input'  && (type === 'search' || SEARCH_CLASS_RE.test(hint));
    const isSearchBtn    = (tag === 'button' || (role === 'button')) && SEARCH_TEXT_RE.test(text);
    const isSearchRole   = role === 'search' || role === 'searchbox';
    const isSearchClass  = SEARCH_CLASS_RE.test(hint);

    if (isSearchInput || isSearchBtn || isSearchRole || isSearchClass) {
      if (isSearchInput)  reasons.push('input=search type/class');
      if (isSearchBtn)    reasons.push('button with search text');
      if (isSearchRole)   reasons.push(`role=${role}`);
      if (isSearchClass)  reasons.push('class/id=search keyword');
      return { category: 'search', confidence: 0.88, reasons };
    }
  }

  // ── 4. Tab / accordion / expandable ──────────────────────────────────────
  {
    const isTabRole      = /^(tab|tablist|tabpanel)$/.test(role);
    const hasExpanded    = node.role && (role === 'button') && /accordion|expand/.test(hint);
    const isTabClass     = /\b(tab|accordion|expand|collapse)\b/.test(hint);

    if (isTabRole || hasExpanded || isTabClass) {
      if (isTabRole)    reasons.push(`role=${role}`);
      if (hasExpanded)  reasons.push('aria-expanded/accordion button');
      if (isTabClass)   reasons.push('class/id=tab/accordion keyword');
      return { category: 'tab', confidence: 0.85, reasons };
    }
  }

  // ── 5. Dropdown / select ──────────────────────────────────────────────────
  {
    const isSelect    = tag === 'select';
    const isCombobox  = role === 'combobox' || role === 'listbox' || role === 'option';
    const isDropdown  = /\b(dropdown|drop-down|select|combobox|selectbox)\b/.test(hint);

    if (isSelect || isCombobox || isDropdown) {
      if (isSelect)   reasons.push('tag=select');
      if (isCombobox) reasons.push(`role=${role}`);
      if (isDropdown) reasons.push('class/id=dropdown keyword');
      return { category: 'dropdown', confidence: 0.87, reasons };
    }
  }

  // ── 6. Checkbox / radio / toggle ─────────────────────────────────────────
  {
    const isCheckbox  = (tag === 'input' && (type === 'checkbox' || type === 'radio'));
    const isSwitch    = role === 'checkbox' || role === 'radio' || role === 'switch';
    const isToggle    = /\b(toggle|switch)\b/.test(hint) && isInteractive(node);

    if (isCheckbox || isSwitch || isToggle) {
      if (isCheckbox)  reasons.push(`tag=input type=${type}`);
      if (isSwitch)    reasons.push(`role=${role}`);
      if (isToggle)    reasons.push('class/id=toggle/switch');
      return { category: 'checkbox', confidence: 0.92, reasons };
    }
  }

  // ── 7. Form container ─────────────────────────────────────────────────────
  {
    if (tag === 'form' || role === 'form') {
      reasons.push(tag === 'form' ? 'tag=form' : `role=${role}`);
      return { category: 'form', confidence: 0.90, reasons };
    }
  }

  // ── 8. Button (generic, after specialized categories) ────────────────────
  {
    const isButtonTag  = tag === 'button';
    const isButtonType = tag === 'input' && /^(button|submit|reset)$/.test(type);
    const isButtonRole = role === 'button';
    // clickable div/span with meaningful text (non-link)
    const isImplicit   = !isButtonTag && !isButtonType && !isButtonRole &&
                          (hint.includes('btn') || hint.includes('button')) &&
                          isInteractive(node) && text.length > 0;

    if (isButtonTag || isButtonType || isButtonRole || isImplicit) {
      if (isButtonTag)   reasons.push('tag=button');
      if (isButtonType)  reasons.push(`tag=input type=${type}`);
      if (isButtonRole)  reasons.push('role=button');
      if (isImplicit)    reasons.push('class/id=btn + interactive + text');
      const confidence = (isButtonTag || isButtonType) ? 0.95
        : isButtonRole ? 0.90
        : 0.75;
      return { category: 'button', confidence, reasons };
    }
  }

  // ── 9. Navigation / menu ─────────────────────────────────────────────────
  {
    const isNavTag    = tag === 'nav';
    const isNavGroup  = group === 'nav' || group === 'header';
    const isNavRole   = role === 'navigation' || role === 'menubar' || role === 'menu';
    const isNavClass  = NAV_CLASS_RE.test(hint);

    if (isNavTag || (isNavGroup && (isNavClass || isNavRole)) || isNavRole) {
      if (isNavTag)    reasons.push('tag=nav');
      if (isNavGroup)  reasons.push(`group=${group}`);
      if (isNavRole)   reasons.push(`role=${role}`);
      if (isNavClass)  reasons.push('class/id=nav keyword');
      return { category: 'nav', confidence: 0.88, reasons };
    }
  }

  // ── 10. Pagination ────────────────────────────────────────────────────────
  {
    const isPaginationClass = PAGINATION_CLASS_RE.test(hint);
    const isPaginationText  = PAGINATION_TEXT_RE.test(text) && tag === 'a' && isInteractive(node);

    if (isPaginationClass || isPaginationText) {
      if (isPaginationClass) reasons.push('class/id=pagination keyword');
      if (isPaginationText)  reasons.push(`text="${text}" matches page nav pattern`);
      return { category: 'pagination', confidence: 0.82, reasons };
    }
  }

  // ── 11. Banner / advertisement ────────────────────────────────────────────
  {
    if (BANNER_CLASS_RE.test(hint)) {
      reasons.push('class/id=banner/ad keyword');
      return { category: 'banner', confidence: 0.75, reasons };
    }
  }

  // ── 12. Card / list item ──────────────────────────────────────────────────
  {
    if (CARD_CLASS_RE.test(hint)) {
      reasons.push('class/id=card/item keyword');
      return { category: 'card', confidence: 0.72, reasons };
    }
    // <li> inside a structured list with children — likely a list item
    if (tag === 'li' && (node.focusScore ?? 0) > 0) {
      reasons.push('tag=li with content');
      return { category: 'card', confidence: 0.65, reasons };
    }
  }

  // ── 13. Input (generic text / textarea) ──────────────────────────────────
  {
    const isTextInput = tag === 'input' && /^(text|email|number|tel|url|date|time|datetime-local|month|week|color|file|range|)$/.test(type);
    const isTextarea  = tag === 'textarea';
    const isInputRole = role === 'textbox' || role === 'spinbutton' || role === 'slider';

    if (isTextInput || isTextarea || isInputRole) {
      if (isTextInput)  reasons.push(`tag=input type=${type || 'text'}`);
      if (isTextarea)   reasons.push('tag=textarea');
      if (isInputRole)  reasons.push(`role=${role}`);
      return { category: 'input', confidence: 0.90, reasons };
    }
  }

  // ── 14. Link ─────────────────────────────────────────────────────────────
  {
    if (tag === 'a' && node.href) {
      reasons.push('tag=a[href]');
      return { category: 'link', confidence: 0.85, reasons };
    }
    if (role === 'link') {
      reasons.push('role=link');
      return { category: 'link', confidence: 0.82, reasons };
    }
  }

  // ── 15. Heading ───────────────────────────────────────────────────────────
  {
    if (HEADING_TAGS.has(tag)) {
      reasons.push(`tag=${tag}`);
      return { category: 'heading', confidence: 0.97, reasons };
    }
    if (role === 'heading') {
      reasons.push('role=heading');
      return { category: 'heading', confidence: 0.90, reasons };
    }
  }

  // ── 16. Media ─────────────────────────────────────────────────────────────
  {
    if (MEDIA_TAGS.has(tag)) {
      reasons.push(`tag=${tag}`);
      return { category: 'media', confidence: 0.95, reasons };
    }
    if (role === 'img') {
      reasons.push('role=img');
      return { category: 'media', confidence: 0.88, reasons };
    }
  }

  // ── 17. Layout regions ────────────────────────────────────────────────────
  {
    const layoutTags  = new Set(['header', 'footer', 'aside', 'main', 'section', 'article']);
    const layoutGroup = new Set(['header', 'footer', 'aside']);

    if (layoutTags.has(tag)) {
      reasons.push(`tag=${tag}`);
      // Distinguish more specific layout regions
      if (tag === 'header' || group === 'header') return { category: 'layout', confidence: 0.90, reasons };
      if (tag === 'footer' || group === 'footer') return { category: 'layout', confidence: 0.90, reasons };
      if (tag === 'aside'  || group === 'aside')  return { category: 'layout', confidence: 0.88, reasons };
      return { category: 'layout', confidence: 0.82, reasons };
    }
    if (layoutGroup.has(group)) {
      reasons.push(`group=${group}`);
      return { category: 'layout', confidence: 0.80, reasons };
    }
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  reasons.push('no matching rule');
  return { category: 'unknown', confidence: 0.10, reasons };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify an array of extracted DOM nodes.
 *
 * Mutates each node in-place (adding functional category fields) and returns
 * the same array for chaining convenience.
 *
 * Added fields per node:
 *   functionalCategory           — category key  (e.g. 'button')
 *   functionalCategoryCode       — short code    (e.g. 'BTN')
 *   functionalCategoryConfidence — 0.0–1.0
 *   labelColor                   — CSS hex       (e.g. '#E53E3E')
 *   categoryReason               — string[]
 *
 * @param {object[]} nodes
 * @returns {object[]}
 */
export function classifyNodes(nodes) {
  for (const node of nodes) {
    const { category, confidence, reasons } = classifyNode(node);
    const meta = CATEGORY_META[category] ?? CATEGORY_META.unknown;
    node.functionalCategory           = category;
    node.functionalCategoryCode       = meta.code;
    node.functionalCategoryConfidence = Math.round(confidence * 100) / 100;
    node.labelColor                   = meta.color;
    node.categoryReason               = reasons;
  }
  return nodes;
}

/**
 * Build the legend object that maps category key → color, code, label, count.
 * Useful for writing annotation-legend.json.
 *
 * @param {object[]} classifiedNodes  — nodes already processed by classifyNodes()
 * @returns {object}
 */
export function buildLegend(classifiedNodes) {
  const counts = {};
  for (const node of classifiedNodes) {
    const cat = node.functionalCategory ?? 'unknown';
    counts[cat] = (counts[cat] ?? 0) + 1;
  }

  const legend = {};
  for (const [key, meta] of Object.entries(CATEGORY_META)) {
    if (counts[key] != null) {
      legend[key] = {
        code:        meta.code,
        color:       meta.color,
        label:       meta.label,
        count:       counts[key] ?? 0,
        description: CATEGORY_DESCRIPTIONS[key] ?? '',
      };
    }
  }

  // Include all categories in the legend even if count is 0, so downstream
  // consumers have a stable schema.
  for (const [key, meta] of Object.entries(CATEGORY_META)) {
    if (!legend[key]) {
      legend[key] = {
        code:        meta.code,
        color:       meta.color,
        label:       meta.label,
        count:       0,
        description: CATEGORY_DESCRIPTIONS[key] ?? '',
      };
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    note: 'Each category key maps to its annotation color, short code, and count of detected elements.',
    categories: legend,
  };
}

// ── Human-readable descriptions for the legend ────────────────────────────────

const CATEGORY_DESCRIPTIONS = {
  login:      'Login/logout, sign-in/up buttons, username/password fields, social auth controls. Detected via text keywords (로그인, login, sign in), href patterns, class/id, and input type=password.',
  modal:      'Dialogs, overlays, popups, lightboxes, and other content that blocks page interaction.',
  search:     'Search input boxes, search submit buttons, and search-scoped form areas.',
  form:       'Top-level form containers grouping inputs and submit actions.',
  tab:        'Tab bars, tab panels, accordion headers, and expandable/collapsible sections.',
  dropdown:   '<select> elements, ARIA comboboxes, listboxes, and dropdown menus.',
  checkbox:   'Checkbox inputs, radio buttons, toggle switches, and ARIA switch controls.',
  button:     'Clickable buttons (non-login, non-search) — <button>, input[type=submit|button|reset], role=button.',
  nav:        'Navigation bars, site menus, breadcrumbs, hamburger menus, and sidebar navigation.',
  pagination: 'Page number links, next/previous controls, and pagination containers.',
  banner:     'Promotional banners, advertisement containers, sponsor ribbons, and ad slots.',
  card:       'Repeated card or list-item containers — product cards, article tiles, result entries.',
  input:      'Generic text/email/date/number/textarea inputs not classified as search or login.',
  link:       'Anchor links not clearly acting as nav menu items or auth controls.',
  heading:    'h1–h6 headings and elements with role=heading.',
  media:      'Images, video elements, <canvas>, <svg>, <iframe>, and other media containers.',
  layout:     'Major layout regions — site header, footer, sidebars, <main>, <section>, <article>.',
  unknown:    'Could not be classified by any heuristic rule.',
};
