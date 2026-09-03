// Content rules for the always-on automod (handlers/autoMod.js).
//
// These approximate the categories Discord prohibits in the Community
// Guidelines that https://discord.com/terms incorporates by reference —
// hate speech, threats, sexualization of minors, self-harm encouragement,
// scams/malware, doxxing, unmarked adult content, and spam.
//
// They are pattern matches, not judgement. Discord's actual rules turn on
// intent and context a regex can't see, so this is a first line of defence
// that catches blatant cases, not a complete reading of the guidelines.
// False positives and misses are both expected — tune the lists below as
// they show up.
//
// The word lists necessarily contain the slurs and scam terms being
// matched; they exist here to be detected and deleted, nothing else.

const LEET = {
  '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a',
  '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g',
};

// Folds the tricks used to slip a banned word past a plain match:
// accents, zero-width characters, leetspeak, and stretched letters
// (niiiice -> niice). Digits are rewritten here, so any rule that cares
// about real digits (domains, ages, phone numbers) must run against
// ctx.lower instead of ctx.normalized.
function normalize(text) {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase()
    .replace(/[0134578@$+!]/g, (c) => LEET[c] ?? c)
    .replace(/(.)\1{2,}/g, '$1$1');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Same word, tolerating up to two separator characters between letters,
// so f.a.g.g.o.t and f a g g o t still match.
function spaced(word) {
  return word.split('').map(escapeRe).join('[^a-z0-9]{0,2}');
}

const SUFFIX = '(?:s|z|es|ed|er|ers|ing|a|as)?';

// Builds a matcher over normalized text. The separator-tolerant variant
// is applied only to words of 6+ characters: on a short word like "fag"
// it would start matching across ordinary sentences.
function wordMatcher(words) {
  const strict = new RegExp(`(?<![a-z0-9])(?:${words.map(escapeRe).join('|')})${SUFFIX}(?![a-z0-9])`);
  const long = words.filter((w) => w.replace(/[^a-z0-9]/g, '').length >= 6);
  const loose = long.length
    ? new RegExp(`(?<![a-z0-9])(?:${long.map(spaced).join('|')})${SUFFIX}(?![a-z0-9])`)
    : null;
  return (text) => strict.test(text) || (loose ? loose.test(text) : false);
}

// ---- Hate speech ------------------------------------------------------------

const SLURS = [
  'nigger', 'nigga', 'niggah', 'chink', 'gook', 'wetback', 'kike',
  'beaner', 'towelhead', 'raghead', 'sandnigger', 'jigaboo', 'porchmonkey',
  'groid', 'muzzie', 'zipperhead',
  'faggot', 'fagot', 'tranny', 'trannie', 'shemale',
  'retard', 'mongoloid',
];

// Same category, but each of these is also an ordinary word, a surname or
// a place name somewhere (Dyke Road, a raccoon, a cigarette in British
// English). They are still slurs and are still filtered by default — but
// if members start tripping the filter innocently, this is the list to
// trim, not the one above.
const AMBIGUOUS_SLURS = ['fag', 'dyke', 'coon', 'spic', 'paki', 'wop', 'dago'];

const matchesSlur = wordMatcher([...SLURS, ...AMBIGUOUS_SLURS]);

const HATE_PHRASE_RE =
  /(?<![a-z0-9])(?:gas the (?:jews|kikes)|kill all (?:jews|blacks|whites|gays|muslims|women|men|trans)|heil hitler|sieg heil|white power|1488|hitler was right|(?:jews|blacks|gays|muslims) (?:are|should be) (?:subhuman|exterminated|gassed))/;

// ---- Violent threats --------------------------------------------------------

const THREAT_RE =
  /(?<![a-z0-9])(?:i(?:'?m| am| will|ll)?\s*(?:g(?:on|oin)?na|going to|will|gon)?\s*(?:kill|murder|stab|shoot|behead|rape|beat)\s+(?:you|u|ya|him|her|them|y'?all)|shoot up (?:the|this|your|a)\s|(?:i(?:'?m| am)?\s*(?:gonna|going to)\s*bomb)|hope you (?:die|get raped)|i know where you live[\s\S]{0,40}(?:kill|hurt|dead|coming for you))/;

// ---- Self-harm encouragement ------------------------------------------------

const SELF_HARM_RE =
  /(?<![a-z0-9])(?:kys|kysm|kill (?:your|ur|yo)\s?self|(?:go |you should |u should |plz |please )(?:go )?(?:die|kill (?:your|ur)self|end (?:it|your life))|neck (?:your|ur)self|hang (?:your|ur)self|rope (?:your|ur)self|drink bleach)(?![a-z0-9])/;

// ---- Sexualization of minors ------------------------------------------------
// The one category Discord treats as zero-tolerance and report-to-Trust-
// and-Safety, so it is checked first and exempts nobody.

// Both halves are word-bounded on purpose: an unbounded "sex" also matches
// "sexist" and an unbounded "kid" matches "kidding", which between them
// would fire this rule — the most serious one in the table — on ordinary
// conversation.
const B = '(?<![a-z0-9])';
const E = '(?![a-z0-9])';

const MINOR =
  B +
  '(?:child|children|kid|kids|minor|minors|toddler|toddlers|infant|preteen|pre teen|' +
  'underage|under age|middle schooler|elementary schooler|' +
  '(?:[3-9]|1[0-7])\\s*(?:yo|y\\/o|years? old|yrs? old))' +
  E;
const SEXUAL =
  B +
  '(?:porn|porno|pornography|p0rn|nude|nudes|naked|sex|sexual|sexually|sexting|nsfw|' +
  'hentai|smut|rape|raping|molest|molesting|blowjob|onlyfans|horny|erotic|cum|fuck|fucking)' +
  E;

const MINOR_SEXUAL_RE = new RegExp(
  '(?<![a-z0-9])(?:loli|lolis|lolicon|shota|shotacon|jailbait|child\\s*p(?:orn|0rn)|childporn|cheese pizza|cp\\s*(?:porn|vids?|folder|link|trade))(?![a-z0-9])' +
    `|${MINOR}[\\s\\S]{0,30}${SEXUAL}|${SEXUAL}[\\s\\S]{0,30}${MINOR}`
);

// ---- Scams, phishing and malware --------------------------------------------
// Run against ctx.lower, not ctx.normalized — domains depend on digits.

const SCAM_RE =
  /free\s*(?:discord\s*)?nitro|nitro\s*(?:giveaway|gift|for free)|steam\s*gift\s*(?:card|link)|(?:claim|redeem)\s*your\s*(?:free\s*)?(?:nitro|gift)|free\s*(?:robux|v-?bucks)|double\s*your\s*(?:btc|eth|bitcoin|crypto)|(?:https?:\/\/)?[\w.-]*(?:d[i1l]s[ck]{1,2}[o0]rd|dicord|discrod|disocrd|steamcommunity|steamcomunity)[\w-]*\.(?:gift|ru|xyz|top|click|link|info|online|site|shop|cf|gq|ml|tk|icu|fun)\b|grabify\.link|iplogger\.(?:org|com|ru)|iplis\.ru|blasze\.(?:com|tk)|yip\.su|2no\.co/;

const ILLEGAL_SERVICE_RE =
  /(?:selling|buy|for sale|dm me for)\s*(?:cheap\s*)?(?:discord\s*)?(?:accounts?|tokens?|nitro codes?)|(?:ddos|booter|stresser|token\s*logger|ip\s*logger|server\s*nuker|rat\s*builder|crypter)\s*(?:service|for sale|selling|for hire|4 sale)|(?:selling|buying)\s*(?:hacked|cracked|stolen)\s*accounts?/;

// ---- Doxxing ----------------------------------------------------------------
// Deliberately narrow: only forms that state outright that personal
// information belongs to someone else. Bare numbers are left alone.

const DOX_RE =
  /(?:his|her|their|this guys?|your|ur)\s*(?:full\s*)?(?:home\s*)?(?:address|addy)\s*(?:is|:)\s*\d+\s+\w+|(?:his|her|their)\s*(?:phone|cell|number)\s*(?:is|:)\s*[\d\-().\s]{9,}|\bssn\s*(?:is|:)?\s*\d{3}-?\d{2}-?\d{4}|(?:dox|doxx)(?:ing|ed)?\s+(?:him|her|them|this guy|you)\b/;

// ---- Adult content outside age-gated channels -------------------------------

const NSFW_LINK_RE =
  /(?:pornhub|xvideos|xnxx|redtube|youporn|xhamster|spankbang|brazzers|chaturbate|stripchat|onlyfans|fansly|rule34|nhentai|e-hentai|hanime|thothub)\.[a-z]{2,}/;

// ---- Rule table -------------------------------------------------------------
// Checked in order, most serious first; the first hit wins. Only one rule
// sets `staffExempt` — posting an adult link is a question of which
// channel it belongs in, which staff can be trusted to judge. Everything
// else, spam included, applies to Administrators too.

const RULES = [
  {
    id: 'minor_safety',
    label: 'sexual content involving minors',
    severity: 'critical',
    staffExempt: false,
    quoteInLog: false,
    // Checked against the raw lowercase text as well: normalize()
    // rewrites digits as letters, which would hide "14 year old" from
    // the age half of the pattern.
    test: (ctx) => MINOR_SEXUAL_RE.test(ctx.normalized) || MINOR_SEXUAL_RE.test(ctx.lower),
  },
  {
    id: 'hate',
    label: 'hate speech or slurs',
    severity: 'high',
    staffExempt: false,
    quoteInLog: true,
    test: (ctx) => matchesSlur(ctx.normalized) || HATE_PHRASE_RE.test(ctx.normalized),
  },
  {
    id: 'threats',
    label: 'threats of violence',
    severity: 'high',
    staffExempt: false,
    quoteInLog: true,
    test: (ctx) => THREAT_RE.test(ctx.normalized),
  },
  {
    id: 'self_harm',
    label: 'encouraging self-harm',
    severity: 'high',
    staffExempt: false,
    quoteInLog: true,
    test: (ctx) => SELF_HARM_RE.test(ctx.normalized),
  },
  {
    id: 'scam',
    label: 'scam, phishing or malware link',
    severity: 'high',
    staffExempt: false,
    quoteInLog: true,
    test: (ctx) => SCAM_RE.test(ctx.lower),
  },
  {
    id: 'illegal_services',
    label: 'selling accounts or attack services',
    severity: 'high',
    staffExempt: false,
    quoteInLog: true,
    test: (ctx) => ILLEGAL_SERVICE_RE.test(ctx.lower),
  },
  {
    id: 'doxxing',
    label: 'sharing private information about someone',
    severity: 'high',
    staffExempt: false,
    quoteInLog: false,
    test: (ctx) => DOX_RE.test(ctx.lower),
  },
  {
    id: 'adult_content',
    label: 'adult content outside an age-restricted channel',
    severity: 'low',
    staffExempt: true,
    quoteInLog: true,
    // Discord allows this in channels marked NSFW, so the rule is about
    // where it was posted, not that it was posted.
    test: (ctx) => !ctx.channelIsNsfw && NSFW_LINK_RE.test(ctx.lower),
  },
  {
    id: 'mass_mention',
    label: 'mass mentions',
    severity: 'low',
    staffExempt: false,
    quoteInLog: false,
    // The @everyone half only fires for members who don't hold Mention
    // Everyone, so staff announcements still go out normally — but the
    // six-mention half applies to them like anyone else.
    test: (ctx) => ctx.mentionCount >= 6 || (ctx.mentionsEveryone && !ctx.mayMentionEveryone),
  },
];

function buildContext(message) {
  const raw = message.content ?? '';
  const member = message.member;
  return {
    message,
    raw,
    lower: raw.toLowerCase(),
    normalized: normalize(raw),
    channelIsNsfw: Boolean(message.channel?.nsfw),
    mentionCount: (message.mentions?.users?.size ?? 0) + (message.mentions?.roles?.size ?? 0),
    mentionsEveryone: /@everyone|@here/.test(raw),
    mayMentionEveryone: Boolean(member?.permissions?.has('MentionEveryone')),
  };
}

module.exports = { RULES, buildContext, normalize };
