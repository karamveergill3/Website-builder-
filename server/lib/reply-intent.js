/**
 * What a prospect's reply means, read by rules.
 *
 * Replies to a cold WhatsApp are short and informal ("nah mate fully booked
 * till christmas 😂", "got one ta 👍", "my lads doing it when hes back from
 * uni"), so each kind is a family of patterns rather than one keyword, and
 * the order they are tried in (lib/reply-draft.js, classifyReply) settles a
 * message that says two things: a stop beats everything; someone else making
 * their site, or a site they already have, beats a polite no; a no beats
 * "later"; "later" beats a price question; a price question beats a yes.
 *
 * Tuned against a few hundred realistic replies of every kind
 * (test/fixtures/replies.json), and held to them by test/reply-intent.test.js.
 * Nothing here is sent on its own: a draft that reads the reply wrongly is
 * shown for the rep to check, and only a "stop" is acted on automatically, so
 * those patterns are the strictest.
 */

const any = (patterns) => (t) => patterns.some((re) => re.test(t));

/** Straight apostrophes, and nothing else changed (line breaks matter to "stop"). */
export const tidy = (text) => String(text ?? '').replace(/[’‘`´]/g, "'");

/* ------------------------------------------------------------------ stop */

// Only an unmistakable ask, because it opts them out on the spot.
export const isStop = any([
  // "Stop", "STOP 🛑", "3rd message this week. STOP." at the start of a sentence,
  // but never "stop by any time" or "stop round the yard Friday".
  /(^|[\n.!?]\s*)stop\b(?!\s+(by|in|round|over|off|at|and|for|to|when|if|worrying|the|a|at|there|here|past)\b)/im,
  /\bplease stop\b/i,
  /\bstop (messaging|messageing|texting|contacting|sending|spamming|bothering|harassing|it)\b/i,
  /\bunsubscribe\b|^\s*unsub\b|\bopt(?:ed|ing)?[ -]?out\b/im,
  /\b(remove|delete|take|scrub|lose)\b[^.!?\n]{0,15}\b(my|this|the|our) (number|details|contact details)\b/i,
  /\bremove (me|us)\b/i,
  /\btake (me|us) off\b/i,
  /\bleave (me|us) alone\b/i,
  /\b(do not|don'?t|dont|never|please don'?t|can you not|could you not|stop)( ever)? (message|messaging|text|texting|contact|contacting|msg|whatsapp|whatsapping|bother|bothering|spam)\b[^.!?\n]{0,25}\b(again|anymore|any more|ever)\b/i,
  /\b(do not|don'?t|dont|never) (message|text|contact|msg|whatsapp|bother) (me|us|this number)\b/i,
  /\bno more (messages|msgs|texts|of these)\b/i,
  /\bspamming (me|us)\b/i,
  /\bblock(ing|ed)? (you|this number|your number)\b/i,
  /\bpack it in\b/i,
  /\b(don'?t|do not) want (to hear|hearing) from you\b/i,
  /\blose (it|my number)\b/i,
]);

/* ------------------------------------------------ what they say of a site */

/** "I don't have a website", "we haven't got a site": about their own, now. */
export const saysNoSite = (t) => /\b(don'?t|dont|do not|haven'?t|havent|have not|never had|never have|without)\b[^.!?\n]{0,20}\b(web ?site|site)\b/i.test(t);

// A plan that fell through: "my son was going to do one but never did".
const fellThrough = /\b(was|were) going (to|with)\b[^.!?\n]{0,50}\b(but|never|didn'?t|let (us|me) down)\b/i;

// They take us up on it, whatever else they say.
const ACCEPT = /\b(go ahead(?! with (him|her|them|someone|another|a |an |the ))|go for it|please do|yes please|yes pls|take you up on|do (a|the) mock ?up|crack on|let'?s do it|send (it|one|me one) (over|through)|so yes|so yeah)\b/i;

const WHO = String.raw`(?:someone|somebody|some(?:one|body) else|a (?:friend|mate|relative) of (?:mine|ours)|a marketing (?:company|agency|firm)|another (?:company|firm|developer|designer|agency)|a (?:lad|guy|bloke|friend|mate|relative|company|firm|local firm|local company|agency|developer|designer|web guy|web designer|web developer|freelancer)|an agency|(?:my|our|his|her|the|me) (?:son|daughter|lad|lads|boy|girl|nephew|niece|brother|sister|husband|wife|wifes \w+|wife's \w+|missus|partner|cousin|dad|mum|friend|mate|mates|brother in law|sister in law|son in law|daughter in law|other half|team|accountant|marketing (?:company|agency|firm)|head office|franchise|franchise head office|web guy|it guy|designer|developer)|(?:the )?wife'?s? \w+|one of (?:the|our|my) (?:lads|team|staff|guys)|\w+ from (?:church|the pub|the gym|work)|(?:the )?\w+ owner'?s? mate|cousin|nephew)`;
const DOING = String.raw`(?:doing|building|making|sorting|designing|setting (?:one |it |ours |the site |a site )?up|working on|knocking up|creating|putting together|started on|going to (?:do|build|make|sort)|on it)`;

// Someone else is making their site: a developer, an agency, a relative.
export const isElsewhere = (t) => {
  if (fellThrough.test(t) || saysNoSite(t)) return false;
  const who = new RegExp(`\\b${WHO}\\b`, 'i').test(t);
  return [
    // "already engaged with a developer", "we're already with someone for this"
    /\b(already|currently|now)\s+(engaged|working|sorted|dealing|speaking|talking|in talks|signed up|booked in|committed|set up|with)\s+(with\s+)?(someone|somebody|another|a (local |web )?(developer|designer|agency|company|firm|guy|lad|bloke)|an agency)\b/i,
    /\b(we'?re|were|we are|i'?m|im)\s+(already\s+)?(with|working with|using|signed up with|going with|going ahead with)\s+(someone|somebody|another|an? (local |web )?(developer|designer|agency|company|firm))\b/i,
    // "my daughter is designing one", "one of the lads is knocking up a site"
    new RegExp(`\\b${WHO}(?:\\s+who)?(?:'s|s| is| are| was| will be| has been|'ll be| has| have)?\\s*(?:already\\s+)?${DOING}\\b`, 'i'),
    // "cousin does websites", "my partner's a developer", "is a web designer"
    new RegExp(`\\b${WHO}(?:\\s+who)?\\s+(?:does|builds|makes|designs|do|build|make)\\s+(?:web ?sites|sites|them|that)\\b`, 'i'),
    new RegExp(`\\b${WHO}(?:'s| is)\\s+(?:a\\s+)?(?:web ?)?(?:developer|designer)\\b`, 'i'),
    // "ive already paid someone to do it", "going ahead with them"
    /\b(paid|paying|hired|commissioned|signed up with|going ahead with|gone with|going with|went with|decided to go with|opted to go with|will be using|i'?ll be using|ill be using)\s+(someone|somebody|another \w+|a (local )?(company|firm|developer|designer|agency|guy|lad|bloke|web guy|web designer)|an agency|the (company|firm|developer|designer|agency|guy|lad)|our (developer|designer|agency|guy)|him|her|them)\b/i,
    new RegExp(`\\b${WHO}\\b[^.!?\\n]{0,30}\\bto (make|build|do|design|sort) (one|it|ours|the site|a site|the website)\\b`, 'i'),
    /\b(using|use|found|booked|got)\s+(a|an|our|my)\s+(web ?developer|web ?designer|developer|agency|design agency|design company|web company)\b/i,
    // "Its being built as we speak", "getting one done through the growth hub"
    /\b(is|'s|s|are|being|getting)\s+(being\s+)?(built|made|designed|set up|created)\b/i,
    /\bgetting (one|a (web ?)?site|it) (done|built|made)\b/i,
    /\b(in the works|underway|under way|beat you to it|started on it)\b/i,
    /\b(should|will|going to|due to)\s+(go live|be up|be live|launch)\b/i,
    /\b(web ?site|site)\b[^.!?\n]{0,15}\blaunch(es|ing)\b/i,
    // "we're having one built by a local company", "someone from my BNI group is doing mine"
    /\bhaving (one|a (web ?)?site|it|ours|the (web ?)?site) (built|made|done|designed|sorted)\b/i,
    /\b(is|are|'s)\s+(already\s+)?(doing|building|making|rebuilding|designing|redoing|sorting|handling)\s+(mine|ours|one|our (new )?(web ?site|site)|my (new )?(web ?site|site)|the (new )?(web ?site|site)|a (new )?(web ?site|site)|all (the|our) [a-z ]{0,15}(web ?sites|sites))\b/i,
    // "head office handles all the website stuff", "the brewery does all that"
    /\b(handles?|does|sorts?|looks after|takes care of|manages?|controls?)\s+(all\s+)?(that|of that|the (web ?site|site|online|web|internet|marketing)( stuff| side| bit)?|our (web ?site|site))\b/i,
    /\b(does|do) (it|this|that|websites?|sites) for a living\b/i,
    /\b(just |already |recently )?(commissioned|ordered|signed (up )?(with|for)|accepted a quote|paid a deposit|put a deposit down)\b/i,
    /\b(talking|speaking|been talking|been speaking|in talks) (to|with) (a|an|another) (local )?(web )?(developer|designer|agency|company|firm)\b/i,
    /\bgo(ing)? ahead with (him|her|them|someone|another|a |an |the )/i,
  ].some((re) => re.test(t)) || (who && /\b(he|she|they)('s|s| is| are|'re| will be)\s+(already\s+)?(doing|building|making|sorting|designing|setting up|working on|knocking up|on it)\b/i.test(t));
};

// Their own site, now: a web address, "got one ta", "we've had one since 2014".
const WEB_ADDRESS = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]{1,60}\.(?:co\.uk|org\.uk|com|org|uk|net|biz|info|shop|store|online|studio|site|website|io)\b/gi;
const NOT_THEIR_SITE = /^(?:https?:\/\/)?(?:www\.)?(facebook|fb|instagram|insta|tiktok|twitter|x|linkedin|checkatrade|yell|mybuilder|ratedpeople|trustatrader|google|bark|nextdoor|treatwell|fresha|booksy|wa|whatsapp|keylo\w*)\./i;
const ownAddress = (t) => [...t.matchAll(WEB_ADDRESS)].some((m) => !NOT_THEIR_SITE.test(m[0]));

export const hasSite = (t) => {
  // "we don't have a website, we have TWO 😅" is the one no-site that isn't.
  const more = /\b(we|i)\s*(have|'ve got|'ve|got|have got)\s+(two|2|three|3|a few|several)\b(?!\s+(kids|children|vans|staff|shops|salons|sites to|jobs))/i;
  if (saysNoSite(t)) return more.test(t) && /\b(don'?t|dont|do not) have (a|one|1|just one) (web ?site|site)\b/i.test(t);
  // "customers keep asking if we've got a website" is not a claim to one.
  const claims = [
    /\b(we|i|we do|i do|we'?ve|i'?ve|already|we actually|we definitely|we do actually|you'?ll see)\s*(have|'ve got|'ve|got|have got|do have|already have|definitely have|actually have)\s+(already\s+)?(a|an|our own|our|two|2)\s+([a-z-]+\s+){0,3}(web ?site|site)s?\b/i,
    /\b(have|'ve got|got|have got|we got|i got|we have)\s+(one|1)\b(?=\s*(?:$|[.,!?)]|👍|😂|🙂|😊|already|ta\b|thanks|thank|cheers|mate|pal|love|hun|lol|tho|though|now|live|online|sorted|x\b|that (i'?m|we'?re|works|does)|which|i'?m happy|we'?re happy))/i,
    // "We have two actually, one for the salon and one for the academy"
    /\b(we|i)\s*(have|'ve got|'ve|got|have got)\s+(two|2|three|3)\b(?=[^.!?\n]{0,25}\b(one for|web ?sites|sites)\b)/i,
    // "No need, got a website my son made", "Got a site mate"
    /(?:^|[,.!\n]\s*)(got|have got|have)\s+(a|an|our own|my own)\s+(web ?site|site)\b/i,
    /\b(not|n'?t)\s+(seen|found|checked|looked at|come across)\s+(our|my)\s+(web ?site|site)\b/i,
    /\balready online\b/i,
    /\b(there'?s|theres|there is)\s+(already\s+)?(a\s+(web ?site|site)|one\b)/i,
    /\b(does|do)\s+(have|has)\s+(a|an|one)\s+([a-z-]+\s+){0,2}(web ?site|site)\b/i,
    /\b(web ?site|site)(?:'s|s| is| has| was)?\s*(?:been\s+|gone\s+)?(live|online|up and running|launched)\b/i,
    /\b(web ?site|site)\s+went\s+live\b/i,
    // "we've had one for years" is a site now; "I had one for 3 years" was one.
    /\b('ve had|have had|has had)\s+(a|one|1|the)(\s+(web ?site|site))?\s+(for|since)\b/i,
    /\bhad\s+(a|one|1|the)(\s+(web ?site|site))?\s+since\b/i,
    /\b(we'?re|were|we are|i'?m|im)\s+(already\s+)?online\b/i,
    /\bcheck (out )?(our|my) (web ?site|site)\b/i,
    /\bgoogle (us|me|[a-z ]{1,30})\b[^.!?\n]{0,40}\b(first|top) (result|thing)\b/i,
    /\bset (our|my|the) (web ?site|site) up\b/i,
    /\b(already )?sorted with a (web ?site|site)\b/i,
  ];
  for (const re of claims) {
    const m = re.exec(t);
    if (!m) continue;
    const before = t.slice(Math.max(0, m.index - 14), m.index);
    if (/\b(if|whether)\s*$/i.test(before) || /(n'?t|\bnot|\bnever|\bno)\s*$/i.test(before)) continue;
    return true;
  }
  return ownAddress(t);
};

/* -------------------------------------------------------------------- no */

const NO_STRONG = [
  /\b(not interested|no thanks|no thank you|no ta|no cheers|nah (ta|thanks|mate|pal|cheers)|not for (us|me)|i'?ll pass|we'?ll pass|going to pass|gonna pass|give it a miss|i'?ll decline|we'?ll decline|not bothered|no point|see the point|waste of (money|time)|never again|not going down that road)\b/i,
  /\b(don'?t|do not|dont|won'?t|wont)\s+(really\s+|actually\s+|even\s+)?(want|need)\s+(one|it|1|a\s+(web ?site|site)|any(thing)?(\s+like that|\s+else)?|that|them|a web site|a website)\b(?!\s+(fancy|big|complicated|special|flash|too|massive|expensive|elaborate|huge))/i,
  /\bno need\b/i,
  /\b(not|isn'?t|never)\s+(really\s+)?(something|anything)\b[^.!?\n]{0,20}\b(interested|need|want|looking)\b/i,
  /\bnot (really |currently |actively )?(looking|after)\s+(for\s+)?(one|a (new )?(web ?site|site)|anything|a website|to get one|to have one)\b/i,
  /\b(not|isn'?t) (needed|necessary|required|worth it|worth my while|for me)\b|\b(web ?site|one) (not |isn'?t )?(needed|necessary)\b/i,
  /\b(selling|sold|handing over|passing on) (the |my |our )?(business|shop|salon|company)\b/i,
  /\b(does|do) (me|us) (fine|just fine|nicely|ok|okay|alright)\b|\b(is|'s) (plenty|enough) for (me|us)\b|\bthat'?s plenty\b/i,
  /\bmore (work|jobs|customers|clients) than (i|we) can (handle|cope with|manage|take on)\b|\blast thing (i|we) need\b|\b(don'?t|do not) want more (customers|work|clients|jobs|people)\b/i,
  /\bwouldn'?t (bring|get|be worth|do) (me|us|it|anything)\b/i,
  /\bcan'?t be doing with\b|\bcan'?t be bothered\b|\b(don'?t|do not) want (customers|people|clients|anyone) (finding|seeing|knowing)\b/i,
  /\btoo busy (for (this|that|it|one|a (web ?)?site)|to (bother|think about))\b/i,
  /\b(like|prefer) (keeping|to keep) (it|things) (small|as it is|as they are)\b/i,
  /\b(not|isn'?t|never)\s+(really\s+)?(something|anything)\s+(i|we)('ve|'d)?\s+(ever\s+)?(need|needed|want|wanted|looking|looked)\b/i,
  /\b(fully|solidly|solid) booked\b|\bbooked (up|solid)\b|\bbooks? (are |is )?full\b|\bat capacity\b|\bturning (jobs|work|people|customers|clients) away\b|\b(get|got|have|getting|had|with|there'?s|theres)\s+(more than\s+)?enough (work|customers|clients|jobs|business)\b|\bmore than enough (work|customers|clients|jobs|business)\b|\bplenty of (work|customers|clients|jobs)\b|\bbusy enough\b|\bgets? (me|us) plenty\b/i,
  /\b(facebook|fb|insta(gram)?|tiktok|checkatrade|google (business|listing|page|profile)|social media|my ?builder|rated ?people|trustatrader)\b[^.!?\n]{0,40}\b(enough|plenty|does (the job|us|it|everything|plenty|fine)|that'?s (all|where)|all (i|we) need|gets? (me|us)|brings? (me|us)|find (us|me)|come from|comes? through)\b/i,
  /\bwhy would (i|we) (pay|need|want)\b/i,
  /\b(had|have had)\s+(one|a (web ?site|site)|a site built|one built)\b[^.!?\n]{0,50}\b(before|years? ago|ago|once|in (19|20)\d\d|back in|never|didn'?t|not a single|nothing|binned|took it down)\b/i,
  /\b(binned it|took it down|taken it down|shut it down|got rid of it|nobody used it|never got (a single|any)|not a single (job|enquiry|customer)|got nothing (back|from it|off it))\b/i,
  /\b(retir(ing|e|ed)|packing up|closing (down|the|up)|winding (down|up)|lease is up|selling up)\b/i,
  /\bhappy (as|with how|the way) (we are|i am|things are|it is)\b|\bhappy as (we|i) (are|am)\b/i,
  /\b(we'?re|were|we are|i'?m|im)\s+(ok|okay|fine|good|sorted|all good|alright)(?!\s+(with|to|for)\b),?\s+(thanks|thank you|cheers|ta|mate|pal|hun|love|x+|as (we|i) (are|am))\b(?![^?]*\bhow (are|r) (you|u)\b)/i,
  /\b(all good|all sorted|we'?re sorted)(\s+(thanks|cheers|ta))?\s*[.!]?\s*$/im,
  /\b(don'?t|do not) do (computers|technology|the internet|online)\b/i,
  /\b(don'?t|do not) have the (capacity|time|budget)\b/i,
  /\bon purpose\b|\bdeliberately\b|\bpurposely\b|\bpurposefully\b/i,
  // "we've taken our website down as we're slowing down"
  /\b(took|taken|take|taking|shut|closed|pulled)\s+(our|my|the)\s+(web ?site|site)\s+(down|offline|off)\b/i,
  /\b(slowing|scaling|cutting|winding) (down|back)\b|\bsemi[- ]retired\b/i,
  /\b(too small|one man band|one woman band)\b/i,
  /\bno\s+(cheers|ta|thanks|thank you)\b/i,
  /^\s*(no|nope|nah|na)\b[\s.,!👎😂🙃🙄🙅‍♀️🙅‍♂️🙅]*$/i,
  /\b(but|sorry|so|lol|haha|ha|thanks|cheers),?\s+no\b(?!\s+(worries|problem|probs|rush|pressure|website|site|logo|harm|objection|chance (til|till|until|before|this|right now|at the)))/i,
  /\bno\s*[.!👎😂🙄]*\s*$/i,
];
// A message that opens with "No" (not "No website yet", "No worries", "No I haven't got one").
const LEADS_WITH_NO = /(^|\n)\s*(no|nope|nah)\b(?!,?\s+(website|site|web|worries|problem|probs|rush|pressure|logo|harm|objections?|idea|i haven|i have|we haven|we have|i don'?t have|we don'?t have|i'?ve not|we'?ve not|i'?m the|im the|i am the|this is|it'?s the))/i;
// Said on their own they lean towards no; beside a yes or a price question, not.
const NO_LEANING = /\b(word of mouth|recommendations?|referrals?|regulars|repeat (customers|business|clients))\b/i;

// "Money's tight" is a no, but "money's tight, what would it cost?" is a price question.
const NO_UNLESS_ASKED = [
  /\b(can'?t|cant|cannot|couldn'?t|could not) (afford|justify|stretch to)\b|\bno (budget|money|spare cash|funds)\b|\bmoney'?s (too )?tight\b/i,
];

export const isNo = (t) => {
  // "not interested if there's a monthly fee, but what's the one off price" is a price question.
  const text = t.replace(/\bnot interested if\b[^.!?\n]*/gi, '');
  return NO_STRONG.some((re) => re.test(text)) || LEADS_WITH_NO.test(text)
    || (!/\?/.test(text) && NO_UNLESS_ASKED.some((re) => re.test(text)));
};
export const leansNo = (t) => NO_LEANING.test(t);

/* ----------------------------------------------------------------- later */

export const isLater = any([
  /\b(not (right )?now|maybe later|later on|(too|very|really) busy|busy at the (moment|minute)|bit busy|next (week|month|year)|new year|get back to you|come back to you|think about it|have a think|in a few (weeks|months)|not at the moment)\b/i,
  /\b(after|in|till|til|until|once|when|around|about)\s+(christmas|xmas|the new year|new year|january|jan|february|feb|march|april|may|june|july|august|september|sept|october|november|december|spring|summer|autumn|winter|easter|half term|the holidays|the hols|the tax year|i'?m back|we'?re back|i get back|we get back|it quietens|things (calm|quieten)|the kids are back|we'?re settled|the extension)\b/i,
  /\b(drop|message|text|try|ask|contact|ping|chase|catch)\s+(me|us)\s+(again\s+)?(after|in|next|when|later|once|around)\b/i,
  /\b(chat|talk|speak|check|run it by|discuss|have a word)\s+(with|to|past|by)\s+(the |my |our )?(wife|husband|partner|other half|missus|business partner|boss|team|trustees|manager|board|accountant)\b/i,
  /\b(leave it with me|let you know|mull it over|sleep on it|not a good time|not a priority|too much on|got a lot on|snowed under|rushed off (my|our) feet|hectic|down the line|at some point|in the future|another time|not right this minute|not just yet|on holiday|away till|reply (properly )?later|have to wait|wait a bit|pick this up|on a job all week)\b/i,
  /\bmaybe\s+(later|down the line|next|in the new year|after|once|in a few)\b/i,
  /\bnot (till|until)\b/i,
  /\bnot (this side of|before|till after|until after)\s+(christmas|xmas|the new year|new year|summer|spring|easter|the holidays)\b/i,
  /\b(message|text|msg|drop|try|contact|ping|ask)\s+(me|us)\s+(again\s+)?(at the |the )?(end of|start of|beginning of)\b/i,
]);

/* ----------------------------------------------------------------- price */

export const isPrice = any([
  /\bhow\s*much\b(?!\s+(info|information|detail|details|time|notice|do you need|stuff|of))/i,
  /\bhows much\b/i,
  /\bwhat(?:'s|s| is| are| would| does| do|'d| sort of)?\b[^.?!\n]{0,30}\b(cost|costs|price|prices|pricing|charge|charging|charges|rates|fee|fees|damage|set me back)\b/i,
  /\b(cost|costs|price|prices|pricing|fee|fees|charge|charges|rates)\s*\?/i,
  /\bballpark\b/i,
  /\bwhat'?s the (catch|damage)\b/i,
  /\b(monthly|per month|a month|one[- ]off|subscription|ongoing costs?|hosting|domain)\b[^.!\n]{0,40}\?/i,
  /\bmonthly (fee|fees|thing|cost|costs|payment)\b/i,
  /\b(send|give) me (your )?(prices|pricing|a quote|rates)\b/i,
  /\bdiscount(ed)? rates?\b/i,
  /\b(is (it|this|that) free|free or what|free free|want(ing)? paying|pay (for it )?after|pay once|pay monthly)\b/i,
  /\bexpensive\b/i,
  /\bdepends on (the )?(cost|price|money)\b/i,
  /\bwhat (u|you) (charging|charge)\b/i,
  /\bcheapest\b/i,
  /£\s?\d/,
  /\b(is|it'?s|is it|is this|this is|that'?s)\s+(really |actually |totally |completely |genuinely |honestly )?free\b/i,
  /\bprice ?list\b|\b(get|getting) a bill\b|\bowe (you )?(anything|owt|money|a penny)\b|\bcheaper than\b|\bdearer than\b/i,
]);

/* ------------------------------------------------------------------- yes */

export const isYes = any([
  ACCEPT,
  /\b(yes|yeah|yea|yep|yup|yh|(?<!(i'?m|im|not|make|be|pretty|quite)\s)sure(?!\s+(you|what|if|how|why|who|it'?s|this|that|there))|ok|okay|go on|go ahead(?! with (him|her|them|someone|another|a |an |the ))|go for it|sounds (good|great|alright|lovely)|please do|why not|(?<!(not|n'?t|not really|never)\s)interested|love (to|one|that)|happy to|happy for you|definitely|of course|alright|aye|let'?s do it|crack on|keen|up for it|wouldn'?t say no|no objections|might be time|cant hurt|can'?t hurt|no harm|do what you need|i'?d like to see|like to see what|would be (nice|handy|great|good|lovely|helpful|brilliant|amazing)|that'?d be (great|good|lovely|handy|brilliant|amazing|helpful)|so helpful)\b/i,
  /👍|👌|🙌/,
]);

export const accepts = (t) => ACCEPT.test(t);

/**
 * "Yes this is Perfect Paws, what's it regarding?", "sure you've got the right
 * place?": a question about who we are or who they are, not an answer.
 */
export const asksWho = any([
  /\bwhat'?s (it|this) (regarding|about)\b/i,
  /\bwho('?s| is) (this|that|it)\b/i,
  /\bhow did you get (this|my|our) number\b/i,
  /\b(right|wrong) (place|number|person|people|business)\b/i,
  /\bis this (a scam|legit|spam|about)\b/i,
  /\bwhat (this|it)('s| is)( all)? about\b|\bnot sure what (this|it|that)\b|\bnot sure what (you'?re|you are|u r|ur) (on )?about\b/i,
  /\bmeant for someone else\b|\bwrong (chat|convo|conversation)\b|\bsent (that|this) to the wrong\b/i,
]);

/**
 * A polite turn-down that names no reason we know: "thanks but I like keeping
 * it small", "Can't be doing with it, sorry". Not when it asks something or
 * takes us up on it.
 */
const DECLINE_CUE = /\b(thanks|thank you|thankyou|thanx|cheers|appreciate(d)?( it| the offer)?|ta)\b[^.!?\n]{0,90}\bbut\b|\b(sorry|i'?m afraid|afraid not|thanks though|cheers though|ta though|thank you though)\b/i;
export const declines = (t) => DECLINE_CUE.test(t) && !/\?/.test(t) && !accepts(t)
  && !/^\s*(yes|yeah|yep|yh|go on|sure|ok|okay|aye)\b/i.test(t);
