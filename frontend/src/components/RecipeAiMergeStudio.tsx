import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton, ModalSubmitButton } from './Modal';
import SourcesReadNote from './SourcesReadNote';
import { apiFetch } from '../lib/api';
import { formatDurationWith } from '../lib/duration';
import { difficultyKey } from '../lib/recipeReport';
import { originsOf } from '../lib/recipeMergeUnified';
import type { UnifiedMergeView } from '../services/recipeMergeUnified.local';

const CHIP = 'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider';
const SECTION_LABEL = 'text-xs font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500';

/** Which versions a row came from: "A", "B+C", or the page mark for a row
 *  only a reference page had. */
function Origin({ from, pageLabel }: { from: string | string[] | null; pageLabel: string }) {
  const letters = originsOf(from);
  return (
    <span className={`${CHIP} shrink-0 ${letters.length ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400' : 'bg-primary/10 text-primary'}`}>
      {letters.length ? letters.join('+') : pageLabel}
    </span>
  );
}

/** "Merge with AI": the model has read the versions and the pages they cite
 *  and written ONE recipe. The dialog shows that recipe, why it reads the
 *  way it does, and what the model could not settle; the user answers and
 *  asks for changes in the chat, and the recipe is rewritten at each turn.
 *  Nothing is saved until "Save the merged recipe".
 *
 *  The merge itself lives in the service (a session id ties the turns
 *  together); this component only shows the latest view of it. */
export default function RecipeAiMergeStudio({
  open,
  onClose,
  keptId,
  otherIds,
  lang,
  onMerged,
}: {
  open: boolean;
  onClose: () => void;
  keptId: string;
  otherIds: string[];
  lang: string;
  onMerged: (targetId: string) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<UnifiedMergeView | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<'recipe' | 'chat'>('recipe');
  const [showReasoning, setShowReasoning] = useState(true);
  const chatEnd = useRef<HTMLDivElement>(null);
  // The merge on screen; a start that answers after the dialog was closed
  // or reopened is dropped rather than shown.
  const run = useRef(0);
  const sessionId = useRef<string | null>(null);

  const post = async (path: string, body: Record<string, unknown>, timeoutMs: number) => {
    const res = await apiFetch(`/api/recipes/ai-merge-unified${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('recipeDetail.aiMergeUnified.failed'));
    return json.data;
  };

  const start = async () => {
    const mine = ++run.current;
    setView(null);
    setError(null);
    setLoading(true);
    setTab('recipe');
    try {
      // Reading the reference pages comes before the model's own time.
      const data = (await post('', { keptId, otherIds, lang }, 420_000)) as UnifiedMergeView;
      if (mine !== run.current) return;
      sessionId.current = data.sessionId;
      setView(data);
    } catch (err) {
      if (mine === run.current) setError(err instanceof Error ? err.message : t('recipeDetail.aiMergeUnified.failed'));
    } finally {
      if (mine === run.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void start();
    return () => {
      run.current++;
      const id = sessionId.current;
      sessionId.current = null;
      if (id) void post('/close', { sessionId: id }, 10_000).catch(() => {});
    };
    // The versions are fixed for the life of one open dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keptId, otherIds.join(',')]);

  // Follow the conversation as it grows, but not on opening: the first
  // thing to read is the recipe at the top, not the end of the chat.
  const seenMessages = useRef(0);
  useEffect(() => {
    const count = view?.messages.length ?? 0;
    const grew = seenMessages.current > 0 && count > seenMessages.current;
    seenMessages.current = count;
    if (grew || sending) chatEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [view?.messages.length, sending]);

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || !view || sending || applying) return;
    setSending(true);
    setError(null);
    setMessage('');
    setTab('chat');
    try {
      setView((await post('/chat', { sessionId: view.sessionId, message: body }, 300_000)) as UnifiedMergeView);
    } catch (err) {
      setMessage(body);
      setError(err instanceof Error ? err.message : t('recipeDetail.aiMergeUnified.failed'));
    } finally {
      setSending(false);
    }
  };

  const apply = async () => {
    if (!view || sending || applying) return;
    setApplying(true);
    setError(null);
    try {
      await post('/apply', { sessionId: view.sessionId }, 120_000);
      sessionId.current = null;
      onMerged(keptId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('recipeDetail.aiMergeUnified.failed'));
    } finally {
      setApplying(false);
    }
  };

  const busy = loading || sending || applying;
  const draft = view?.draft ?? null;
  const pageLabel = t('recipeDetail.aiMergeUnified.fromPage');
  const missing = new Set(view?.notInLibrary ?? []);
  const total = draft ? (draft.prepTimeMin || 0) + (draft.cookTimeMin || 0) + (draft.restTimeMin || 0) : 0;
  const facts = draft ? [
    draft.servings ? t('recipeDetail.aiMergeUnified.servings', { count: draft.servings }) : null,
    draft.prepTimeMin ? `${t('recipeDetail.prepTime')}: ${formatDurationWith(t, draft.prepTimeMin, { short: true })}` : null,
    draft.restTimeMin ? `${t('recipeDetail.waitingTime')}: ${formatDurationWith(t, draft.restTimeMin, { short: true })}` : null,
    draft.cookTimeMin ? `${t('recipeDetail.cookTime')}: ${formatDurationWith(t, draft.cookTimeMin, { short: true })}` : null,
    total ? `${t('recipeDetail.totalTime')}: ${formatDurationWith(t, total, { short: true })}` : null,
    draft.difficulty && difficultyKey[draft.difficulty] ? t(difficultyKey[draft.difficulty]) : null,
  ].filter((f): f is string => !!f) : [];

  return (
    <Modal
      open={open}
      onClose={applying ? () => {} : onClose}
      size="xl"
      zIndex={130}
      closeOnBackdrop={false}
      title={t('recipeDetail.aiMergeUnified.title')}
      subtitle={view ? t('recipeDetail.aiMergeUnified.subtitle', { count: view.recipes.length }) : undefined}
      footer={
        <div className="flex w-full flex-col gap-3">
          {view && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => { e.preventDefault(); void send(message); }}
            >
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(message); }
                }}
                rows={1}
                disabled={applying}
                placeholder={t('recipeDetail.aiMergeUnified.chatPlaceholder')}
                aria-label={t('recipeDetail.aiMergeUnified.chatPlaceholder')}
                className="sc-field min-h-[2.75rem] max-h-32 flex-1 resize-y"
              />
              <button
                type="submit"
                disabled={busy || !message.trim()}
                aria-label={t('recipeDetail.aiMergeUnified.send')}
                className="shrink-0 inline-flex h-11 w-11 items-center justify-center rounded-full bg-primary text-white disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-[20px]">{sending ? 'sync' : 'send'}</span>
              </button>
            </form>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ModalCancelButton onClick={onClose}>{t('common.cancel')}</ModalCancelButton>
            {error && !view && (
              <ModalSubmitButton type="button" onClick={() => void start()} disabled={loading}>
                {t('recipeDetail.aiMergeUnified.retry')}
              </ModalSubmitButton>
            )}
            {view && (
              <ModalSubmitButton type="button" onClick={() => void apply()} disabled={busy}>
                {applying ? t('recipeDetail.aiMergeUnified.saving') : t('recipeDetail.aiMergeUnified.save')}
              </ModalSubmitButton>
            )}
          </div>
        </div>
      }
    >
      {loading && (
        <div className="py-10 text-center">
          <span className="material-symbols-outlined text-3xl text-primary animate-spin">sync</span>
          <p className="mt-3 text-sm font-bold text-zinc-700 dark:text-zinc-200">{t('recipeDetail.aiMergeUnified.loading')}</p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('recipeDetail.aiMergeUnified.loadingHint')}</p>
        </div>
      )}

      {error && <p className="mb-4 rounded-2xl bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}

      {view && draft && (
        <div className="space-y-4">
          {/* Phones show one of the two at a time; wider screens both. */}
          <div role="tablist" className="flex gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 p-1 md:hidden">
            {(['recipe', 'chat'] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`flex-1 rounded-full px-3 py-1.5 text-xs font-black ${tab === key ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100' : 'text-zinc-500 dark:text-zinc-400'}`}
              >
                {t(key === 'recipe' ? 'recipeDetail.aiMergeUnified.tabRecipe' : 'recipeDetail.aiMergeUnified.tabChat')}
                {key === 'chat' && view.doubts.length > 0 && (
                  <span className="ml-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] text-white">{view.doubts.length}</span>
                )}
              </button>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            {/* ── The unified recipe ─────────────────────────────── */}
            <div className={`space-y-4 min-w-0 ${tab === 'recipe' ? '' : 'max-md:hidden'}`}>
              <section className="rounded-2xl border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4">
                <p className={SECTION_LABEL}>{t('recipeDetail.aiMergeUnified.draft')}</p>
                <h3 className="mt-1 text-xl font-black leading-tight text-zinc-900 dark:text-zinc-100 break-words">{draft.title}</h3>
                {draft.description && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap break-words">{draft.description}</p>}
                {facts.length > 0 && <p className="mt-3 text-xs font-bold text-zinc-500 dark:text-zinc-400">{facts.join(' · ')}</p>}

                <p className={`${SECTION_LABEL} mt-5`}>{t('recipeDetail.aiMergeUnified.ingredients', { count: draft.ingredients.length })}</p>
                <ul className="mt-2 space-y-1.5">
                  {draft.ingredients.map((ing, i) => {
                    const groupStart = ing.groupName && ing.groupName !== draft.ingredients[i - 1]?.groupName;
                    const amount = [ing.quantity != null ? String(+ing.quantity.toFixed(3)) : ing.quantityText, ing.unit].filter(Boolean).join(' ');
                    return (
                      <li key={i}>
                        {groupStart && <p className="mt-3 mb-1 text-xs font-black text-zinc-700 dark:text-zinc-200">{ing.groupName}</p>}
                        <div className="flex items-start gap-2 text-sm text-zinc-800 dark:text-zinc-100">
                          <Origin from={ing.from} pageLabel={pageLabel} />
                          <span className="min-w-0 break-words">
                            {amount && <span className="font-bold tabular-nums">{amount} </span>}
                            {ing.label}
                            {ing.notes && <span className="text-zinc-500 dark:text-zinc-400"> ({ing.notes})</span>}
                            {ing.isOptional && <span className="text-zinc-500 dark:text-zinc-400"> · {t('recipeDetail.aiMergeUnified.optional')}</span>}
                            {!ing.from && missing.has(ing.label) && (
                              <span className={`${CHIP} ml-1.5 bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200`}>{t('recipeDetail.aiMergeUnified.notInLibraryChip')}</span>
                            )}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                <p className={`${SECTION_LABEL} mt-5`}>{t('recipeDetail.aiMergeUnified.steps', { count: draft.steps.length })}</p>
                <ol className="mt-2 space-y-3">
                  {draft.steps.map((step, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-zinc-800 dark:text-zinc-100">
                      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-black text-primary">{i + 1}</span>
                      <span className="min-w-0 flex-1 break-words">
                        {step.title && <span className="font-black">{step.title}. </span>}
                        <span className="whitespace-pre-wrap">{step.text}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Origin from={step.from} pageLabel={pageLabel} />
                          {step.durationMin ? <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 tabular-nums">{formatDurationWith(t, step.durationMin)}</span> : null}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>

                {draft.tips && (
                  <>
                    <p className={`${SECTION_LABEL} mt-5`}>{t('recipeDetail.aiMergeUnified.tips')}</p>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap break-words">{draft.tips}</p>
                  </>
                )}
                {draft.storage && (
                  <>
                    <p className={`${SECTION_LABEL} mt-5`}>{t('recipeDetail.aiMergeUnified.storage')}</p>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap break-words">{draft.storage}</p>
                  </>
                )}
              </section>

              <section className="rounded-2xl bg-zinc-50 dark:bg-zinc-900 px-4 py-3">
                <p className={SECTION_LABEL}>{t('recipeDetail.aiMergeUnified.versions')}</p>
                <ul className="mt-2 space-y-1">
                  {view.recipes.map((r, i) => (
                    <li key={r.id} className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                      <span className={`${CHIP} shrink-0 bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300`}>{r.letter}</span>
                      <span className="min-w-0 break-words">
                        <span className="font-bold">{r.title}</span>
                        {i === 0 ? ` · ${t('recipeDetail.aiMergeUnified.keptVersion')}` : ` · ${t('recipeDetail.aiMergeUnified.foldedVersion')}`}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{t('recipeDetail.aiMergeUnified.keepsNote')}</p>
              </section>

              <SourcesReadNote sources={view.sourcesRead} />

              {view.notInLibrary.length > 0 && (
                <p className="rounded-2xl bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-xs text-amber-800 dark:text-amber-200">
                  {t('recipeDetail.aiMergeUnified.notInLibrary', { names: view.notInLibrary.join(', ') })}
                </p>
              )}
              {view.hasTranslations && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('recipeDetail.aiMergeUnified.translationsNote')}</p>
              )}
            </div>

            {/* ── Reasoning, doubts and the conversation ──────────── */}
            <div className={`space-y-4 min-w-0 ${tab === 'chat' ? '' : 'max-md:hidden'}`}>
              {view.reasoning.length > 0 && (
                <section className="rounded-2xl bg-zinc-50 dark:bg-zinc-900 px-4 py-3">
                  <button type="button" onClick={() => setShowReasoning((v) => !v)} aria-expanded={showReasoning} className={`flex w-full items-center justify-between ${SECTION_LABEL}`}>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[16px]">lightbulb</span>
                      {t('recipeDetail.aiMergeUnified.reasoning')}
                    </span>
                    <span className="material-symbols-outlined text-[18px]">{showReasoning ? 'expand_less' : 'expand_more'}</span>
                  </button>
                  {showReasoning && (
                    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-zinc-700 dark:text-zinc-200">
                      {view.reasoning.map((point, i) => <li key={i} className="break-words">{point}</li>)}
                    </ul>
                  )}
                </section>
              )}

              {view.doubts.length > 0 && (
                <section className="rounded-2xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
                  <p className="inline-flex items-center gap-1.5 text-xs font-black uppercase tracking-widest text-amber-800 dark:text-amber-200">
                    <span className="material-symbols-outlined text-[16px]">help</span>
                    {t('recipeDetail.aiMergeUnified.doubts', { count: view.doubts.length })}
                  </p>
                  <ul className="mt-2 space-y-3">
                    {view.doubts.map((doubt, i) => (
                      <li key={i}>
                        <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100 break-words">{doubt.question}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {doubt.options.map((option) => (
                            <button
                              key={option}
                              type="button"
                              disabled={busy}
                              onClick={() => void send(`${doubt.question} ${option}`)}
                              className="rounded-full bg-white dark:bg-zinc-900 border border-amber-300 dark:border-amber-800 px-3 py-1.5 text-xs font-black text-zinc-800 dark:text-zinc-100 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-amber-800/80 dark:text-amber-200/80">{t('recipeDetail.aiMergeUnified.doubtsHint')}</p>
                </section>
              )}

              {view.warnings.length > 0 && (
                <section>
                  <p className={SECTION_LABEL}>{t('recipeDetail.aiCheck.notes')}</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">
                    {view.warnings.map((w) => <li key={w} className="break-words">{w}</li>)}
                  </ul>
                </section>
              )}

              <section aria-live="polite">
                <p className={`inline-flex items-center gap-1.5 ${SECTION_LABEL}`}>
                  <span className="material-symbols-outlined text-[16px]">chat</span>
                  {t('recipeDetail.aiMergeUnified.chat')}
                </p>
                <ul className="mt-2 space-y-2">
                  {view.messages.map((m, i) => (
                    <li key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <p className={`max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
                        m.role === 'user' ? 'bg-primary text-white' : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100'
                      }`}>
                        {m.text}
                      </p>
                    </li>
                  ))}
                  {sending && (
                    <li className="flex justify-start">
                      <p className="inline-flex items-center gap-2 rounded-2xl bg-zinc-100 dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
                        <span className="material-symbols-outlined text-[16px] animate-spin">sync</span>
                        {t('recipeDetail.aiMergeUnified.thinking')}
                      </p>
                    </li>
                  )}
                </ul>
                {view.messages.length <= 1 && !sending && (
                  <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{t('recipeDetail.aiMergeUnified.chatHint')}</p>
                )}
                <div ref={chatEnd} />
              </section>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
