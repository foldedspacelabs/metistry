"""Board: Knowledge — what Metis learned, what needs your eye, and how it works.

Screen 10. Drawn 2026-09-22, then rebuilt the same day: the first pass organised
itself around `knowledge_pages` and `collector_health` and came out a file browser
with a status header. Section 5.1 of the amendments — written the night before —
names that exact mistake. This version is ordered by what the owner came for.
"""
from lib import *

CW,CH=2560,4520

def win(T,inner):
    return (f'<div style="flex-grow: 1; min-width: 0; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'overflow: hidden; background: {T["bg"]};">{toolbar(T)}'
            f'<div style="display: flex; align-items: stretch;">{sidebar8(T,"Knowledge")}{inner}</div></div>')

INTENT=pan(L,"THE QUESTION THE SCREEN ANSWERS",
  '<table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">'
  + f'<tr style="color: {L["tt"]}; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;">'
    f'<th style="padding: 0 12px 8px 0; width: 46%;">WHY THE OWNER OPENED IT</th>'
    f'<th style="padding: 0 0 8px 0;">WHAT IS THERE</th></tr>'
  + "".join(f'<tr style="border-top: 1px solid {L["border"]};">'
    f'<td style="padding: 9px 12px 9px 0; color: {L["tp"]}; font-weight: 600;">{a}</td>'
    f'<td style="padding: 9px 0; color: {L["ts"]};">{b}</td></tr>'
    for a,b in [
      ("&ldquo;What did it learn last night?&rdquo;","The fold, in prose, at the top"),
      ("&ldquo;Is anything waiting on me?&rdquo;","<b>Needs your eye</b> &mdash; drafts, conflicts, suggestions"),
      ("&ldquo;What is in here, roughly?&rdquo;","<b>Areas</b>, each with a written summary"),
      ("&ldquo;How does this even work?&rdquo;","One rule per section, said where it applies"),
      ("&ldquo;Are the feeds alive?&rdquo;","One line, folded, until it isn&rsquo;t")])
  + '</table>'
  + nt(L,"The first pass answered the last question first. It was a status page with a file list under it, and "
        "<b>a source that is working should be ignorable</b> &mdash; the owner said so: <i>if they&rsquo;re working "
        "fine the user should be able to ignore them almost entirely.</i>",14)
  + nt(L,"Ordering by intent inverts the pass: <b>prose the assistant wrote</b> leads, and the machinery that "
        "produced it sits at the bottom in one line. This is §5.1 of the amendments applied to the surface that "
        "broke it.",12))

FOLD=pan(L,"THE DIGEST ALREADY EXISTS, AND NOTHING SHOWS IT",
  nt(L,"<b>routines/knowledge-fold/run.ts</b> writes <b>Journal/Fold/&lt;date&gt;.md</b> nightly &mdash; prose, "
       "from <b>Templates/Fold.md</b>, &ldquo;in its own voice, as its own commit.&rdquo; It is the one template "
       "where <b>{{ prose }}</b> is legal (D14), and the routine never reads its own output.")
  + nt(L,"So <i>summaries of new knowledge areas</i> is not a thing to invent. It is a file the owner has to open "
        "Obsidian to find. <b>Surfacing it is the whole of the change.</b>",12)
  + nt(L,"Drawn in the <b>agent wash and serif</b>, with the source path shown, because P1 holds hardest here: "
        "this is the longest stretch of agent text in the product and <b>every control in it is the reader&rsquo;s, "
        "not the text&rsquo;s</b>. Page names inside the prose are links &mdash; the one exception, and only "
        "because a path is a reference, not an action.",12)
  + nt(L,"<b>Open The Fold</b> goes to the file. <b>Earlier Folds</b> goes to the directory. The thumbs are the same "
        "feedback control the transcript uses; a fold is a generated answer and gets judged like one.",12))

EYE=pan(L,"RELEVANCE IS PROVENANCE, NOT A RANK",
  f'<div style="background: {L["bg"]}; border: 1px solid {L["border"]}; border-radius: 11px; '
  f'padding: 12px 15px;">'
  + "".join(f'<div style="display: flex; gap: 12px; align-items: baseline; padding: 7px 0;'
            + ("" if i==3 else f' border-bottom: 1px solid {L["border"]};') + '">'
            f'<span style="font-size: 12px; color: {L["tp"]}; font-weight: 600; width: 210px; '
            f'flex-shrink: 0;">{a}</span>'
            f'<span style="font-size: 11.5px; color: {L["ts"]}; line-height: 1.5;">{b}</span></div>'
    for i,(a,b) in enumerate([
      ("Changed by you 2 hours ago","<b>knowledge_files.mtime</b> &mdash; a fact on the row"),
      ("Named by last night&rsquo;s fold","the fold&rsquo;s own wikilinks &mdash; a fact in a file"),
      ("Behind work #418","<b>knowledge_page_links</b> reached from the task &mdash; a join"),
      ("Linked from 6 pages","incoming link count &mdash; a count, not a weight")])) + '</div>'
  + nt(L,"The owner asked for <i>the knowledge that&rsquo;s most interesting and relevant to them</i>. The tempting "
        "answer is a relevance score, and <b>P5 forbids it</b>: a score is inferred, unexplainable, and cannot be "
        "argued with.",14)
  + nt(L,"Each line above is instead <b>a reason the reader can check</b>. Same job, no invention &mdash; and when "
        "one is wrong the owner can see <i>why</i> it is wrong, which a number never permits.",12)
  + nt(L,"<b>The count rides the section header, not a badge.</b> P2: <b>Needs You</b> is the only badge in the "
        "product, and these items are <i>already</i> requests there. A second badge would count them twice.",12))

SPLIT=pan(L,"DECIDE IN NEEDS YOU · EDIT ON KNOWLEDGE",
  nt(L,"A draft settlement is a <b>review_decisions</b> row &mdash; <b>kind: draft_settle</b>, alongside "
       "<b>knowledge | report | grant_elevation | action</b>. The migration&rsquo;s own comment: &ldquo;A "
       "note&rsquo;s <b>status: draft</b> frontmatter marks the same row.&rdquo; One pending thing, two places it "
       "can be seen.")
  + nt(L,"So the split is not a duplication, it is the same row read twice. <b>Needs You</b> asks <i>yes or "
        "no</i> in a queue you work down. <b>Knowledge</b> gives the prose reading width and an <b>Edit First</b> "
        "button, because a draft that is nearly right is corrected, not declined.",12)
  + nt(L,"<b>Answering either answers both.</b> The card says so in as many words &mdash; <i>this arrived as a "
        "request, so answering it here answers it there</i> &mdash; because two surfaces showing one pending item "
        "is only honest if the screen admits it.",12)
  + nt(L,"<b>Correction to the overnight pass.</b> That board said <i>a draft is invisible to you too, and that is "
        "deliberate</i>. True of the <b>knowledge_pages</b> query; wrong about intent. The exclusion protects "
        "<b>agents</b> from unreviewed prose. Hiding a draft from the owner hides the only person who can settle "
        "it. Drafts belong in review, not in the browse list &mdash; where they are, now.",12))

CONFLICT_P=pan(L,"CONFLICT IS THE FIRST REAL INSTANCE OF PARTIAL (C28)",
  f'<div style="background: {L["bg"]}; border: 1px solid {L["border"]}; border-radius: 11px; overflow: hidden;">'
  + f'<div style="display: grid; grid-template-columns: 268px minmax(0,1fr) 116px; gap: 14px; padding: 7px 16px; '
    f'font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {L["tt"]}; background: {L["sunken"]};">'
    f'<span>PATH</span><span>TITLE</span><span style="text-align: right;">MODIFIED</span></div>'
  + pagerow(L,path="Areas/Health/sleep.md",title="Sleep",when="2 hours ago")
  + pagerow(L,path="Areas/Health/2026/sleep.md",title="",when="",status="conflict",last=True) + '</div>'
  + nt(L,"<b>knowledge_files.status</b> is <b>clean | dirty | conflict</b>, and the query&rsquo;s comment is the "
        "design constraint: a conflict row is a file the reconciler could not settle, <b>so its title and mtime are "
        "not facts yet</b>. Path known, metadata not &mdash; the fifth state C28 proposed and could not place.",14)
  + nt(L,"The owner asked to <i>resolve conflicts interactively</i>, so the row is now a doorway rather than a dead "
        "end: it opens the <b>diff</b>, both sides named by who wrote them and when.",12)
  + nt(L,"<b>No auto-merge, and no fourth button.</b> Keep mine · take the fold&rsquo;s · merge in Obsidian. A "
        "three-way merge inside the console would be the console mutating the vault by inference, which invariant "
        "10 closes. Obsidian is the editor; this screen is where the decision is made.",12)
  + nt(L,"<b>Recommendation, restated:</b> ratify <b>partial</b>. Two surfaces now need it.",12))

TEACH=pan(L,"THE TEACHING LAYER IS IN SITU, NOT IN A HELP PAGE",
  f'<div style="background: {L["sunken"]}; border-radius: 10px; padding: 13px 15px;">'
  + "".join(f'<div style="padding: 7px 0;' + ("" if i==4 else f' border-bottom: 1px solid {L["border"]};') + '">'
            f'<div style="font-size: 11px; font-weight: 700; letter-spacing: 0.06em; color: {L["tt"]};">{a}</div>'
            f'<div style="font-size: 12px; color: {L["tp"]}; line-height: 1.5; margin-top: 3px;">{b}</div></div>'
    for i,(a,b) in enumerate([
      ("UNDER THE FOLD","Metis writes here, in its own voice, as its own commit. <b>Your own daily note is never "
       "touched</b> &mdash; one writer per file, and this is not that file."),
      ("UNDER NEEDS YOUR EYE","A draft is <b>never served to an agent</b>. Marking a note <b>status: draft</b> is "
       "how you keep it from your own agents until you have read it."),
      ("UNDER AREAS","A folder <b>is</b> a permission boundary: a grant names a path prefix, so organising your "
       "vault is also configuring what an agent can reach."),
      ("ON A DRAFT","This arrived as a request, so answering it here answers it there."),
      ("ON A CONFLICT","<b>One writer per file</b> is the rule that makes the vault safe to share with agents. A "
       "conflict is that rule holding &mdash; the alternative is a silent overwrite.")])) + '</div>'
  + nt(L,"The owner asked to <i>learn about how Metistry stores knowledge and makes it actionable</i>. Five "
        "sentences, each attached to the thing it governs, each one the <b>architectural</b> reason rather than a "
        "usage tip &mdash; a folder is a permission boundary, not <i>folders help you stay organised</i>.",14)
  + nt(L,"Drawn at the foot of its section in the <b>tertiary</b> ink with the knowledge glyph, so it reads as the "
        "same habit the four states already have: <b>say your own reason</b>. It is not dismissible &mdash; a rule "
        "that can be turned off stops being a rule, and it costs one line.",12))

CALLS=pan(L,"JUDGEMENT CALLS, AND WHAT MOVED OUT",
  nt(L,"The rework dropped two things the first pass drew. Both are named rather than quietly gone.")
  + "".join(f'<div style="display: flex; gap: 10px; align-items: flex-start; padding: 8px 0;'
            + ("" if i==4 else f' border-bottom: 1px solid {L["border"]};') + '">'
            f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
            f'padding-top: 2px; width: 18px;">{i+1}</span>'
            f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
    for i,v in enumerate([
      "<b>The page table is gone from the top level.</b> A flat list of every file answered <i>what is in here</i> "
      "with data instead of meaning. <b>Areas</b> answers it with a written line each; the table lives behind an "
      "area and behind search.",
      "<b>Sources fold to one line.</b> <i>4 sources, all current</i> &mdash; and it expands itself when one is "
      "not, which is the only time the detail earns the space. The <b>stale</b> and <b>failed</b> drawings are kept "
      "intact inside it; C1 is still unanswered by the wire, four rounds on.",
      "<b>The two link lists stay, on a page.</b> They answer <i>what points at this</i>, which is a question the "
      "owner has while reading a page &mdash; not while opening the screen. Still no graph.",
      "<b>Areas get a written summary, which nothing produces yet.</b> A file count is available and is not an "
      "answer. This is a request, not a claim: the fold already writes prose, so the same routine can write one "
      "line per area.",
      "<b>Search is a control in the title bar, not a section.</b> Everything below it is the answer to <i>I did "
      "not know what I was looking for</i>; search is for when you do."])))

body=(heading("ROUND E · SCREEN 10, REBUILT","Knowledge — what it learned, what needs you, and how it works",
   "The first pass was a file browser with a status header, because it was organised around the queries. This one "
   "is ordered by why the owner opened the screen: the fold&rsquo;s prose leads, what is waiting comes next, areas "
   "are described rather than counted, and the sources that work stay out of the way.",L)
  + row(win(L,knowledgepane2(L)),18)
  + row(INTENT+FOLD,18)
  + row(f'<div style="display: flex; gap: 18px; flex-grow: 1; align-items: flex-start;">'
        + f'<div style="width: 760px; flex-shrink: 0; border: 1px solid {L["bc"]}; border-radius: 14px; '
          f'overflow: hidden;">{draftreview(L)}</div>'
        + f'<div style="flex-grow: 1; min-width: 0;">{SPLIT}</div></div>',18)
  + row(f'<div style="display: flex; gap: 18px; flex-grow: 1; align-items: flex-start;">'
        + f'<div style="width: 760px; flex-shrink: 0; border: 1px solid {L["bc"]}; border-radius: 14px; '
          f'overflow: hidden;">{conflictresolve(L)}</div>'
        + f'<div style="flex-grow: 1; min-width: 0;">{CONFLICT_P}</div></div>',18)
  + row(EYE+TEACH,18)
  + row(CALLS+pan(L,"SOURCES, EXPANDED — THE ONLY TIME THEY EARN THE SPACE",
        sourceline(L,ok=False)
        + nt(L,"<b>The age rides the name and never replaces the value</b> &mdash; stale annotates, it does not "
              "blank. And <b>failed carries two timestamps</b>: <i>last succeeded 2 days ago &middot; token "
              "expired</i> says the data is two days old and the reason is known. <i>Failed 2 hours ago</i> would "
              "invite the reader to think the data was two hours old, which is a quieter lie.",14)
        + nt(L,"Collapsed, this is one green dot and five words. The owner never has to look at it, which was the "
              "point.",12)),18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="border: 1px solid {D["bc"]}; border-radius: 12px; overflow: hidden; display: flex; '
          f'gap: 0;">' + knowledgepane2(D,1180) + f'<div style="width: 1px; background: {D["border"]};"></div>'
        + draftreview(D) + '</div></div>',18))
(PROJ/"Knowledge.dc.html").write_text(page("Knowledge",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Knowledge.dc.html ({CW}x{CH})")
