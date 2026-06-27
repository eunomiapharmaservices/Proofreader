'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { signOut } from 'next-auth/react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface User { name?: string; email?: string; image?: string }

interface Issue {
  id: string;
  category: 'grammar' | 'currency' | 'typo' | 'formatting';
  severity: 'error' | 'warning' | 'info';
  description: string;
  original: string | null;
  suggestion: string | null;
  learnRule: string | null;
  ignoreKey: string | null;
}

interface CheckResult {
  scores: { overall: number; grammar: number; currency: number; typos: number };
  summary: string;
  issues: Issue[];
}

interface UserRule {
  id: string;
  rule_text: string;
  rule_type: 'learned' | 'custom' | 'ignored';
  created_at: string;
}

interface UserPrefs {
  currency: 'pound' | 'GBP' | 'both';
  english: 'UK' | 'US';
  context: 'pharma' | 'general' | 'legal' | 'medical' | 'marketing';
  show_suggestions: boolean;
}

interface UserStats { docs: number; corrections: number }

type Tab = 'check' | 'rules' | 'prefs' | 'history';
type FeedbackState = 'accepted' | 'dismissed' | 'snoozed';

// ─── File text extraction ─────────────────────────────────────────────────────

async function extractText(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  if (['txt', 'rtf', 'csv', 'md'].includes(ext)) return file.text();

  if (['docx', 'pptx', 'xlsx'].includes(ext)) {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(file);
    const clean = (xml: string) =>
      xml.replace(/<\/w:p>/g, '\n').replace(/<\/a:p>/g, '\n')
         .replace(/<[^>]+>/g, ' ')
         .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
         .replace(/\s+/g, ' ').replace(/\n +/g, '\n').trim();
    const parts: string[] = [];

    if (ext === 'docx') {
      const xml = await zip.file('word/document.xml')?.async('text');
      if (xml) parts.push(clean(xml));
    } else if (ext === 'pptx') {
      const slides = Object.keys(zip.files).filter(f => /ppt\/slides\/slide\d+\.xml$/.test(f)).sort();
      for (const s of slides) { const xml = await zip.file(s)?.async('text'); if (xml) parts.push(clean(xml)); }
    } else if (ext === 'xlsx') {
      const ss = await zip.file('xl/sharedStrings.xml')?.async('text');
      if (ss) parts.push(clean(ss));
    }
    return parts.join('\n').trim() || '[Could not extract text from this file]';
  }

  if (ext === 'pdf') {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc =
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += (content.items as any[]).map(x => x.str).join(' ') + '\n';
    }
    return text.trim() || '[No extractable text — may be a scanned PDF]';
  }

  return file.text();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const scoreColour = (n: number) => n >= 80 ? 'text-emerald-600' : n >= 60 ? 'text-amber-500' : 'text-red-500';
const catIcon: Record<string, string> = { grammar: '✏️', currency: '£', typo: '🔤', formatting: '⌨️' };

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProofreadingAgent({ user }: { user: User }) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<Tab>('check');
  const [file, setFile] = useState<File | null>(null);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileReading, setFileReading] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [feedback, setFeedback] = useState<Record<string, FeedbackState>>({});

  const [rules, setRules] = useState<UserRule[]>([]);
  const [prefs, setPrefs] = useState<UserPrefs>({ currency: 'pound', english: 'UK', context: 'pharma', show_suggestions: true });
  const [stats, setStats] = useState<UserStats>({ docs: 0, corrections: 0 });
  const [newRule, setNewRule] = useState('');
  const [log, setLog] = useState<{ ts: string; msg: string }[]>([]);

  const addLog = (msg: string) =>
    setLog(prev => [{ ts: new Date().toLocaleTimeString(), msg }, ...prev].slice(0, 60));

  // Load all user data from KV on mount
  const load = useCallback(async () => {
    const [r, p, s] = await Promise.all([
      fetch('/api/rules').then(r => r.json()),
      fetch('/api/prefs').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
    ]);
    if (Array.isArray(r)) setRules(r);
    if (p && !p.error) setPrefs(p);
    if (s && !s.error) setStats(s);
  }, []);

  useEffect(() => { load(); }, [load]);

  // KV mutations
  const mutateRules = async (method: string, body: object) => {
    const r = await fetch('/api/rules', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (Array.isArray(data)) setRules(data);
  };

  const mutatePrefs = async (updated: UserPrefs) => {
    setPrefs(updated);
    await fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updated) });
  };

  const mutateStat = async (field: keyof UserStats) => {
    setStats(prev => ({ ...prev, [field]: prev[field] + 1 }));
    await fetch('/api/stats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field }) });
  };

  // Run proofreading check
  const runCheck = async () => {
    let text = '';
    if (file) {
      setFileReading(true);
      text = await extractText(file);
      setFileReading(false);
      if (text.startsWith('[')) { addLog('Could not extract text from file'); return; }
    } else {
      text = paste.trim();
    }
    if (!text) return;

    setBusy(true);
    setResult(null);
    setFeedback({});

    const activeRules = rules.filter(r => r.rule_type !== 'ignored').map(r => r.rule_text);
    const ignored = rules.filter(r => r.rule_type === 'ignored').map(r => r.rule_text);

    const currencyInstruction =
      prefs.currency === 'pound' ? 'Use £ symbol (e.g. £50). Flag any use of "GBP" as inconsistent.' :
      prefs.currency === 'GBP'   ? 'Use "GBP" notation. Flag £ symbol as inconsistent.' :
                                   'Flag mixed use of £ and GBP within the same document.';

    const prompt = `You are an expert proofreading assistant for ${prefs.context === 'pharma' ? 'a pharmaceutical compliance organisation' : `a ${prefs.context} organisation`}, using ${prefs.english} English.

Currency rule: ${currencyInstruction}
${activeRules.length ? `\nUSER-DEFINED RULES — apply these with highest priority:\n${activeRules.map(r => `- ${r}`).join('\n')}` : ''}
${ignored.length ? `\nSUPPRESSED PATTERNS — do not flag these:\n${ignored.map(r => `- ${r}`).join('\n')}` : ''}

Perform a thorough check across:
1. Grammar — subject-verb agreement (is/are, was/were, has/have), tense consistency, pronoun agreement
2. Currency — £ vs GBP consistency, spacing (£50 not £ 50)
3. Typos — spelling errors, doubled words, wrong homophones (their/there, its/it's, etc.), ${prefs.english === 'UK' ? 'flag American spellings' : 'flag British spellings'}
4. Formatting — inconsistent capitalisation, heading style, punctuation patterns

Respond ONLY in valid JSON with no markdown fences, no commentary before or after:
{
  "scores": {
    "overall": <integer 0-100>,
    "grammar": <integer 0-100>,
    "currency": <integer 0-100>,
    "typos": <integer 0-100>
  },
  "summary": "<2 concise sentences: overall assessment and top priority>",
  "issues": [
    {
      "id": "<4-char unique alphanumeric id>",
      "category": "grammar|currency|typo|formatting",
      "severity": "error|warning|info",
      "description": "<specific, actionable description of the issue>",
      "original": "<exact text from document, max 8 words — null if not applicable>",
      "suggestion": "<corrected version — null if not applicable>",
      "learnRule": "<short reusable rule to remember if user accepts, e.g. 'Always use £ not GBP' — null if not useful>",
      "ignoreKey": "<brief pattern key to suppress if user dismisses — null if not useful>"
    }
  ]
}

Return at most 8 issues, ordered by severity. Be specific — quote exact text where possible.

TEXT TO PROOFREAD (first 2500 characters):
"""
${text.slice(0, 2500)}
"""`;

    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data = await res.json();
      const raw = (data.content as any[])?.map((c: any) => c.text ?? '').join('') ?? '';
      const parsed: CheckResult = JSON.parse(raw.replace(/```json|```/g, '').trim());
      setResult(parsed);
      await mutateStat('docs');
      addLog(`Checked "${file?.name ?? 'pasted text'}" — ${parsed.issues.length} issue(s) found`);
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    }
    setBusy(false);
  };

  // Handle issue feedback
  const giveFeedback = async (issue: Issue, action: FeedbackState) => {
    setFeedback(prev => ({ ...prev, [issue.id]: action }));
    if (action === 'accepted') {
      if (issue.learnRule && !rules.some(r => r.rule_text === issue.learnRule)) {
        await mutateRules('POST', { text: issue.learnRule, type: 'learned' });
        addLog(`Rule learned: "${issue.learnRule}"`);
      } else {
        addLog('Correction accepted');
      }
      await mutateStat('corrections');
    } else if (action === 'dismissed') {
      if (issue.ignoreKey && !rules.some(r => r.rule_text === issue.ignoreKey)) {
        await mutateRules('POST', { text: issue.ignoreKey, type: 'ignored' });
        addLog(`Pattern suppressed: "${issue.ignoreKey}"`);
      } else {
        addLog('Issue dismissed');
      }
    } else {
      addLog('Issue skipped for now');
    }
  };

  const addCustomRule = async () => {
    const t = newRule.trim();
    if (!t) return;
    await mutateRules('POST', { text: t, type: 'custom' });
    addLog(`Custom rule added: "${t.slice(0, 60)}"`);
    setNewRule('');
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const activeRuleCount = rules.filter(r => r.rule_type !== 'ignored').length;
  const severityBorder = (s: string) => s === 'error' ? 'border-red-300' : s === 'warning' ? 'border-amber-300' : 'border-blue-300';
  const severityBadge = (s: string) => s === 'error' ? 'bg-red-50 text-red-600' : s === 'warning' ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600';

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">

      {/* Top nav */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-xs">E</div>
          <span className="text-sm font-semibold text-gray-500 tracking-wide">Eunomia</span>
          <span className="text-gray-200 mx-1">/</span>
          <span className="text-sm text-gray-800 font-medium">Proofreading agent</span>
          <span className="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded-full">adaptive</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5 text-xs text-gray-400">
            <span className="bg-white border border-gray-100 rounded-full px-2.5 py-1">Docs <b className="text-gray-700">{stats.docs}</b></span>
            <span className="bg-white border border-gray-100 rounded-full px-2.5 py-1">Fixes <b className="text-gray-700">{stats.corrections}</b></span>
            <span className="bg-white border border-gray-100 rounded-full px-2.5 py-1">Rules <b className="text-gray-700">{activeRuleCount}</b></span>
          </div>
          <button onClick={() => signOut({ callbackUrl: '/login' })}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
            Sign out
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-6">
        {(['check', 'rules', 'prefs', 'history'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm -mb-px border-b-2 transition-colors ${t === tab ? 'border-blue-500 text-blue-600 font-medium' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
            {t === 'check' ? 'Check document' : t === 'prefs' ? 'Preferences' : t === 'history' ? 'Session log' : 'My rules'}
          </button>
        ))}
      </div>

      {/* ── Check ── */}
      {tab === 'check' && (
        <div>
          <div
            onDrop={e => { e.preventDefault(); e.dataTransfer.files[0] && setFile(e.dataTransfer.files[0]); setResult(null); }}
            onDragOver={e => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-gray-200 hover:border-blue-300 rounded-2xl p-8 text-center cursor-pointer bg-white hover:bg-blue-50/20 transition-all">
            <div className="text-4xl mb-3">📄</div>
            <p className="text-sm font-medium text-gray-700">Drop a file here, or click to browse</p>
            <p className="text-xs text-gray-400 mt-1.5">Word · PDF · PowerPoint · Excel · plain text</p>
            <input ref={fileRef} type="file" className="hidden"
              accept=".docx,.pdf,.pptx,.xlsx,.txt,.rtf,.md,.csv"
              onChange={e => { e.target.files?.[0] && setFile(e.target.files[0]); setResult(null); }} />
            {file && (
              <div className="inline-flex items-center gap-2 mt-4 bg-blue-50 text-blue-700 rounded-full px-3 py-1 text-sm font-medium">
                {file.name}
                <button onClick={e => { e.stopPropagation(); setFile(null); setResult(null); }}
                  className="hover:text-blue-900 font-bold leading-none">×</button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 my-5">
            <hr className="flex-1 border-gray-100" />
            <span className="text-xs text-gray-400">or paste text directly</span>
            <hr className="flex-1 border-gray-100" />
          </div>

          <textarea value={paste} onChange={e => { setPaste(e.target.value); setResult(null); }} rows={6}
            placeholder="Paste an email, report, slide notes, or any text…"
            className="w-full text-sm border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-300 bg-white text-gray-800 resize-y leading-relaxed transition-colors" />

          <div className="flex items-center justify-between mt-4">
            <button onClick={runCheck}
              disabled={busy || fileReading || (!file && !paste.trim())}
              className="px-6 py-2.5 text-sm font-semibold rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {fileReading ? 'Reading file…' : busy ? 'Analysing…' : 'Run proofreading →'}
            </button>
            {paste.trim() && <span className="text-xs text-gray-400">{paste.length.toLocaleString()} characters</span>}
          </div>

          {/* Results */}
          {result && (
            <div className="mt-8 space-y-4">
              {/* Score cards */}
              <div className="grid grid-cols-4 gap-3">
                {([['Overall', result.scores.overall], ['Grammar', result.scores.grammar], ['Currency', result.scores.currency], ['Spelling', result.scores.typos]] as [string, number][]).map(([l, v]) => (
                  <div key={l} className="bg-white border border-gray-100 rounded-xl p-3 text-center">
                    <div className="text-xs text-gray-400 uppercase tracking-wide mb-1.5">{l}</div>
                    <div className={`text-2xl font-semibold ${scoreColour(v)}`}>{Math.round(v)}</div>
                  </div>
                ))}
              </div>

              {result.summary && (
                <div className="bg-white border border-gray-100 rounded-xl px-4 py-3.5 text-sm text-gray-700 leading-relaxed">
                  {result.summary}
                </div>
              )}

              {result.issues.length === 0 ? (
                <div className="flex items-center gap-2 bg-emerald-50 text-emerald-700 rounded-xl px-4 py-3 text-sm font-medium">
                  ✓ No issues found — looking good.
                </div>
              ) : (
                result.issues.map(issue => {
                  const fb = feedback[issue.id];
                  return (
                    <div key={issue.id}
                      className={`bg-white rounded-xl px-4 py-4 border border-gray-100 border-l-4 ${severityBorder(issue.severity)}`}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm">{catIcon[issue.category]}</span>
                        <span className="text-xs text-gray-400 uppercase tracking-wide">{issue.category}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${severityBadge(issue.severity)}`}>{issue.severity}</span>
                      </div>
                      <p className="text-sm text-gray-800 leading-relaxed mb-2">{issue.description}</p>
                      <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                        {issue.original && (
                          <span>Found: <code className="bg-red-50 text-red-700 px-1.5 py-0.5 rounded font-mono">{issue.original}</code></span>
                        )}
                        {issue.suggestion && prefs.show_suggestions && (
                          <span>Fix: <code className="bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded font-mono">{issue.suggestion}</code></span>
                        )}
                      </div>
                      <div className="flex gap-2 mt-3 flex-wrap">
                        {([
                          { action: 'accepted' as FeedbackState, label: `✓ Accept${issue.learnRule ? ' + learn' : ''}`, active: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
                          { action: 'dismissed' as FeedbackState, label: `Dismiss${issue.ignoreKey ? ' + ignore' : ''}`, active: 'bg-red-50 text-red-600 border-red-200' },
                          { action: 'snoozed' as FeedbackState, label: 'Skip', active: 'bg-amber-50 text-amber-600 border-amber-200' },
                        ]).map(({ action, label, active }) => (
                          <button key={action} onClick={() => giveFeedback(issue, action)}
                            className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${fb === action ? active : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'}`}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Rules ── */}
      {tab === 'rules' && (
        <div>
          <p className="text-sm text-gray-400 mb-5 leading-relaxed">
            Rules are injected into every check, shaping what the AI looks for. They build up automatically as you accept and dismiss issues.
          </p>

          {!rules.length && (
            <div className="text-center py-12 text-sm text-gray-400">
              No rules yet. Check a document and use the feedback buttons to start building your profile.
            </div>
          )}

          {(['learned', 'custom', 'ignored'] as const).map(type => {
            const filtered = rules.filter(r => r.rule_type === type);
            if (!filtered.length) return null;
            const colours = { learned: 'bg-emerald-50 text-emerald-700', custom: 'bg-purple-50 text-purple-700', ignored: 'bg-red-50 text-red-500' };
            const labels = { learned: 'Learned from feedback', custom: 'Your custom rules', ignored: 'Suppressed patterns' };
            return (
              <div key={type} className="mb-6">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">{labels[type]}</div>
                <div className="space-y-2">
                  {filtered.map(r => (
                    <div key={r.id} className="flex items-center gap-3 bg-white border border-gray-100 rounded-xl px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${colours[type]}`}>{type}</span>
                      <span className={`text-sm flex-1 leading-snug ${type === 'ignored' ? 'text-gray-400 line-through' : 'text-gray-700'}`}>{r.rule_text}</span>
                      <button onClick={() => mutateRules('DELETE', { id: r.id })}
                        className="text-gray-300 hover:text-red-400 transition-colors text-lg leading-none flex-shrink-0">×</button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          <div className="mt-4">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Add a custom rule</div>
            <div className="flex gap-2">
              <input value={newRule} onChange={e => setNewRule(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addCustomRule()}
                placeholder='e.g. Always use "healthcare" not "health care"'
                className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2.5 focus:outline-none focus:border-blue-300 bg-white text-gray-800 transition-colors" />
              <button onClick={addCustomRule}
                className="px-4 py-2.5 text-sm font-medium bg-blue-600 text-white rounded-xl hover:bg-blue-700 whitespace-nowrap transition-colors">
                Add rule
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Prefs ── */}
      {tab === 'prefs' && (
        <div className="bg-white border border-gray-100 rounded-2xl divide-y divide-gray-100">
          {[
            { label: 'Currency standard', sub: 'How pound amounts should be written', key: 'currency',
              opts: [['pound', '£ symbol  (e.g. £50)'], ['GBP', 'GBP  (e.g. GBP 50)'], ['both', 'Mixed — flag conflicts only']] },
            { label: 'English variant', sub: 'Spelling standard to enforce', key: 'english',
              opts: [['UK', 'UK English'], ['US', 'US English']] },
            { label: 'Document context', sub: 'Helps the bot handle specialist terminology correctly', key: 'context',
              opts: [['pharma', 'Pharmaceutical / compliance'], ['general', 'General business'], ['legal', 'Legal'], ['medical', 'Medical / clinical'], ['marketing', 'Marketing / comms']] },
          ].map(({ label, sub, key, opts }) => (
            <div key={key} className="flex items-center justify-between px-5 py-4">
              <div>
                <div className="text-sm font-medium text-gray-800">{label}</div>
                <div className="text-xs text-gray-400 mt-0.5">{sub}</div>
              </div>
              <select value={(prefs as any)[key]}
                onChange={e => mutatePrefs({ ...prefs, [key]: e.target.value })}
                className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-700 focus:outline-none focus:border-blue-300 cursor-pointer">
                {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          ))}

          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <div className="text-sm font-medium text-gray-800">Show fix suggestions</div>
              <div className="text-xs text-gray-400 mt-0.5">Display the corrected version alongside each flagged issue</div>
            </div>
            <button onClick={() => mutatePrefs({ ...prefs, show_suggestions: !prefs.show_suggestions })}
              className={`w-11 h-6 rounded-full relative transition-colors flex-shrink-0 ${prefs.show_suggestions ? 'bg-blue-500' : 'bg-gray-200'}`}>
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all duration-200 ${prefs.show_suggestions ? 'left-6' : 'left-1'}`} />
            </button>
          </div>
        </div>
      )}

      {/* ── History ── */}
      {tab === 'history' && (
        !log.length
          ? <div className="text-center py-12 text-sm text-gray-400">No activity yet this session.</div>
          : <div className="bg-white border border-gray-100 rounded-2xl divide-y divide-gray-100">
              {log.map((e, i) => (
                <div key={i} className="flex gap-4 px-5 py-3 text-sm">
                  <span className="text-xs text-gray-400 font-mono mt-0.5 flex-shrink-0">{e.ts}</span>
                  <span className="text-gray-700 leading-snug">{e.msg}</span>
                </div>
              ))}
            </div>
      )}
    </div>
  );
}
