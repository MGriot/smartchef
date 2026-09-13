import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Autocomplete from './Autocomplete';
import RenderStepText from './RenderStepText';
import AutoTextarea from './AutoTextarea';
import {
  buildRef, stepIngredientConsumption, remainingBeforeStep,
  type StepIngredientRefLike, type StepLike,
} from '../lib/stepRefs';

interface IngredientOption {
  sortOrder: number;
  ingredientName: string;
  quantity: number | null;
  unitId?: string | null;
  unitSymbol?: string | null;
  /** Alternate ways to name this ingredient mid-sentence — its plural, its
   *  synonyms, its translations. Offered as the "show as" suggestions so a
   *  reference can read naturally without giving up pointing at the row. */
  aliases?: string[];
}

interface ToolOption {
  id: string;
  name: string;
  aliases?: string[];
}

interface TechniqueOption {
  id: string;
  name: string;
  aliases?: string[];
}

interface UnitOption {
  id: string;
  symbol: string;
}

export type StepIngredientAmount = {
  amountMode: 'fraction' | 'absolute';
  portion?: number;
  quantity?: number;
  unitId?: string;
  unitSymbol?: string;
};

interface StepEditorProps {
  description: string;
  onChangeDescription: (text: string) => void;
  ingredients: IngredientOption[];
  tools: ToolOption[];
  techniques: TechniqueOption[];
  units?: UnitOption[];
  /** This step's own ingredient links, so the preview shows the amounts
   *  this step uses rather than the recipe's totals. */
  stepIngredients?: StepIngredientRefLike[];
  /** Every step of the recipe, in order, plus this step's index — used to
   *  offer "what's left by now" when pinning an exact amount. Omitted by
   *  callers that don't have the whole list to hand. */
  allSteps?: StepLike[];
  stepIndex?: number;
  onInsertIngredient?: (sortOrder: number, amount: StepIngredientAmount) => void;
  onInsertTool?: (toolId: string) => void;
}

type Popover = 'ingredient' | 'tool' | 'technique' | null;

/** "% of the total", "an exact amount", or "just the name". The third is
 *  not an amount at all — it is how a reference gets to read "aggiungi la
 *  farina" mid-sentence, when the amount was already stated three words
 *  earlier. */
type PickAmountMode = 'fraction' | 'absolute' | 'none';

const amountText = (qty: number, unitSymbol?: string | null): string =>
  `${qty % 1 === 0 ? qty : Number(qty.toFixed(2))}${unitSymbol ? ` ${unitSymbol}` : ''}`;

/**
 * A step description textarea with a small toolbar to insert inline
 * references — {{ing:N}}, {{tool:id}}, {{tech:id|params}} — at the cursor,
 * plus a live preview showing how they'll render (bold + underlined,
 * Bimby-style) once expanded. See lib/stepRefs.ts for the token grammar.
 *
 * `tools` should be the full tool library (not just the recipe's
 * already-selected tools) so a tool can be referenced inline before it's
 * been added to the dedicated Tools section — the caller is responsible for
 * flagging it there once `onInsertTool` fires.
 */
export default function StepEditor({
  description, onChangeDescription, ingredients, tools, techniques, units = [],
  stepIngredients = [], allSteps, stepIndex,
  onInsertIngredient, onInsertTool,
}: StepEditorProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [popover, setPopover] = useState<Popover>(null);

  const [pickIngredient, setPickIngredient] = useState('');
  const [pickAmountMode, setPickAmountMode] = useState<PickAmountMode>('fraction');
  const [pickPortion, setPickPortion] = useState(1);
  const [pickQuantity, setPickQuantity] = useState<number | null>(null);
  const [pickUnitId, setPickUnitId] = useState<string | null>(null);
  const [pickAlias, setPickAlias] = useState('');
  const [pickTool, setPickTool] = useState('');
  const [pickToolAlias, setPickToolAlias] = useState('');
  const [pickTechnique, setPickTechnique] = useState('');
  const [pickTechniqueAlias, setPickTechniqueAlias] = useState('');
  const [pickParams, setPickParams] = useState('');
  // Escape hatch for the filtered list below: an ingredient the earlier
  // steps have fully spoken for is hidden, not forbidden — "the flour you
  // set aside" is a real sentence.
  const [showUsedUp, setShowUsedUp] = useState(false);

  const insertAtCursor = (token: string) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? description.length;
    const end = el?.selectionEnd ?? description.length;
    const next = description.slice(0, start) + token + description.slice(end);
    onChangeDescription(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const resetIngredientPicker = () => {
    setPickIngredient('');
    setPickAmountMode('fraction');
    setPickPortion(1);
    setPickQuantity(null);
    setPickUnitId(null);
    setPickAlias('');
  };

  const selectedIngredient = ingredients.find(i => String(i.sortOrder) === pickIngredient);

  /** How much of each ingredient is still unspoken for when this step runs.
   *  null where the question does not apply — an ingredient with no numeric
   *  total ("q.b."), or a caller that did not hand over the step list. */
  const remainingFor = (ing: IngredientOption): number | null => {
    if (!allSteps || stepIndex === undefined) return null;
    return remainingBeforeStep(allSteps, stepIndex, {
      sortOrder: ing.sortOrder,
      quantity: ing.quantity,
      unitSymbol: ing.unitSymbol,
    });
  };

  /** The dropdown listed the whole ingredient list on every step, so by the
   *  last step of a twenty-ingredient recipe you scrolled past nineteen
   *  things that were already in the pot to find the one that wasn't. What
   *  earlier steps have used up is dropped — unless it is what this step
   *  already references (you must be able to edit that) or the user asks
   *  for the full list. */
  const usedUp = (ing: IngredientOption): boolean => {
    if (stepIngredients.some(si => si.ingredientSortOrder === ing.sortOrder)) return false;
    const left = remainingFor(ing);
    return left !== null && left <= 1e-9;
  };
  const availableIngredients = showUsedUp ? ingredients : ingredients.filter(i => !usedUp(i));
  const hiddenCount = ingredients.length - availableIngredients.length;
  const selectedTool = tools.find(tool => tool.id === pickTool);
  const selectedTechnique = techniques.find(tech => tech.id === pickTechnique);

  /** What the recipe still has of the picked ingredient by the time this
   *  step runs. Shown next to the exact-amount box, and one click fills it
   *  in — the "I already used 500 of the 620 g, how much is left" question
   *  that otherwise has to be answered in your head against every earlier
   *  step. */
  const remainingForPicked = (): number | null => {
    if (!selectedIngredient || !allSteps || stepIndex === undefined) return null;
    return remainingBeforeStep(allSteps, stepIndex, {
      sortOrder: selectedIngredient.sortOrder,
      quantity: selectedIngredient.quantity,
      unitSymbol: selectedIngredient.unitSymbol,
    });
  };

  const confirmIngredient = () => {
    if (!pickIngredient) return;
    if (pickAmountMode === 'absolute' && !pickQuantity) return;
    const sortOrder = parseInt(pickIngredient, 10);
    const unit = units.find(u => u.id === pickUnitId);
    const alias = pickAlias.trim();

    if (pickAmountMode === 'none') {
      // `q=` with nothing after it: the renderer prints the name alone.
      insertAtCursor(buildRef('ing', sortOrder, { alias: alias || undefined, amount: '' }));
    } else if (pickAmountMode === 'absolute') {
      insertAtCursor(buildRef('ing', sortOrder, {
        alias: alias || undefined,
        amount: amountText(pickQuantity!, unit?.symbol ?? selectedIngredient?.unitSymbol),
      }));
      onInsertIngredient?.(sortOrder, {
        amountMode: 'absolute',
        quantity: pickQuantity ?? undefined,
        unitId: pickUnitId ?? undefined,
        unitSymbol: unit?.symbol,
      });
    } else {
      const consumed = selectedIngredient
        ? stepIngredientConsumption(
            { ingredientSortOrder: sortOrder, amountMode: 'fraction', portion: pickPortion },
            { sortOrder, quantity: selectedIngredient.quantity, unitSymbol: selectedIngredient.unitSymbol },
          )
        : null;
      insertAtCursor(buildRef('ing', sortOrder, {
        alias: alias || undefined,
        amount: consumed != null ? amountText(consumed, selectedIngredient?.unitSymbol) : undefined,
      }));
      onInsertIngredient?.(sortOrder, { amountMode: 'fraction', portion: pickPortion });
    }
    setPopover(null);
    resetIngredientPicker();
  };

  const confirmTool = () => {
    if (!pickTool) return;
    insertAtCursor(buildRef('tool', pickTool, { alias: pickToolAlias.trim() || undefined }));
    onInsertTool?.(pickTool);
    setPopover(null);
    setPickTool('');
    setPickToolAlias('');
  };

  const confirmTechnique = () => {
    if (!pickTechnique) return;
    insertAtCursor(buildRef('tech', pickTechnique, {
      alias: pickTechniqueAlias.trim() || undefined,
      free: pickParams.trim() || undefined,
    }));
    setPopover(null);
    setPickTechnique('');
    setPickTechniqueAlias('');
    setPickParams('');
  };

  const previewIngredients = ingredients.map(i => {
    const ref = stepIngredients.find(si => si.ingredientSortOrder === i.sortOrder);
    const consumed = ref
      ? stepIngredientConsumption(ref, { sortOrder: i.sortOrder, quantity: i.quantity, unitSymbol: i.unitSymbol })
      : null;
    const stepQuantity = !ref
      ? undefined
      : ref.amountMode === 'absolute'
        ? (ref.quantity != null ? amountText(ref.quantity, ref.unitSymbol || i.unitSymbol) : undefined)
        : (consumed != null ? amountText(consumed, i.unitSymbol) : undefined);
    return {
      sortOrder: i.sortOrder,
      name: i.ingredientName,
      quantity: i.quantity != null ? amountText(i.quantity, i.unitSymbol) : '',
      stepQuantity,
    };
  });

  /** Alias suggestions for whichever entity is being referenced. A datalist
   *  rather than a select, so a one-off wording nobody wants in the catalog
   *  is still just typed in. */
  const aliasDatalist = (id: string, options: string[]) => (
    <datalist id={id}>
      {[...new Set(options.filter(Boolean))].map(a => <option key={a} value={a} />)}
    </datalist>
  );

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <button type="button" onClick={() => setPopover(popover === 'ingredient' ? null : 'ingredient')}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${popover === 'ingredient' ? 'bg-primary text-white' : 'bg-primary/10 text-primary hover:bg-primary/20'}`}>
          <span className="material-symbols-outlined text-sm">restaurant</span> {t('editors.ingredient')}
        </button>
        <button type="button" onClick={() => setPopover(popover === 'tool' ? null : 'tool')}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${popover === 'tool' ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}>
          <span className="material-symbols-outlined text-sm">construction</span> {t('editors.tool')}
        </button>
        <button type="button" onClick={() => setPopover(popover === 'technique' ? null : 'technique')}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${popover === 'technique' ? 'bg-sky-500 text-white' : 'bg-sky-50 text-sky-700 hover:bg-sky-100'}`}>
          <span className="material-symbols-outlined text-sm">whatshot</span> {t('editors.technique')}
        </button>
      </div>

      {popover === 'ingredient' && (
        <div className="flex items-end gap-2 mb-2 bg-primary/5 border border-primary/10 rounded-xl p-3 flex-wrap">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.ingredient')}</label>
            <Autocomplete
              value={pickIngredient}
              options={availableIngredients.map(i => {
                const left = remainingFor(i);
                // The amount shown is what is still available at this step,
                // not the recipe's total — the total is the wrong number to
                // reach for once three steps have taken a share of it.
                const shown = left ?? i.quantity;
                return {
                  id: String(i.sortOrder),
                  label: `${i.ingredientName || t('editors.unnamed')}${shown ? ` — ${amountText(shown, i.unitSymbol)}` : ''}`,
                  sublabel: left !== null && i.quantity != null && left < i.quantity
                    ? t('editors.ofTotal', { total: amountText(i.quantity, i.unitSymbol) })
                    : undefined,
                };
              })}
              onSelect={(id) => {
                setPickIngredient(id);
                const ing = ingredients.find(i => String(i.sortOrder) === id);
                setPickUnitId(ing?.unitId ?? null);
                setPickAlias('');
              }}
              onClear={() => { setPickIngredient(''); setPickUnitId(null); setPickAlias(''); }}
              placeholder={t('editors.search')}
              className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-sm font-bold"
            />
          </div>
          <div className="flex-1 min-w-[150px]">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.showAs')}</label>
            <input
              type="text" list="step-ing-aliases" value={pickAlias}
              onChange={e => setPickAlias(e.target.value)}
              placeholder={selectedIngredient?.ingredientName || t('editors.showAsPlaceholder')}
              className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-sm font-bold"
            />
            {aliasDatalist('step-ing-aliases', [
              selectedIngredient?.ingredientName || '',
              ...(selectedIngredient?.aliases ?? []),
            ])}
          </div>
          <div>
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.amount')}</label>
            <div className="flex bg-white dark:bg-zinc-900 rounded-lg p-0.5 border border-zinc-100 dark:border-zinc-800">
              {([
                ['fraction', t('editors.percentOfTotal')],
                ['absolute', t('editors.exactAmount')],
                ['none', t('editors.nameOnly')],
              ] as const).map(([mode, label]) => (
                <button key={mode} type="button" onClick={() => setPickAmountMode(mode)}
                  className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${pickAmountMode === mode ? 'bg-primary text-white' : 'text-zinc-400 dark:text-zinc-500'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {pickAmountMode === 'fraction' && (
            <div className="w-28">
              <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.portionPercent', { percent: Math.round(pickPortion * 100) })}</label>
              <input type="range" min="0.05" max="1" step="0.05" value={pickPortion} onChange={e => setPickPortion(parseFloat(e.target.value))} className="w-full accent-primary" />
            </div>
          )}
          {pickAmountMode === 'absolute' && (
            <>
              <div className="w-24">
                <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.qty')}</label>
                <input
                  type="number" step="any" value={pickQuantity ?? ''}
                  onChange={e => setPickQuantity(e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-sm font-bold"
                />
              </div>
              <div className="w-24">
                <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.unit')}</label>
                <select
                  value={pickUnitId || ''}
                  onChange={e => setPickUnitId(e.target.value || null)}
                  className="w-full px-2 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-xs font-bold"
                >
                  <option value="">{t('editors.unitPlaceholder')}</option>
                  {units.map(u => <option key={u.id} value={u.id}>{u.symbol}</option>)}
                </select>
              </div>
            </>
          )}
          <button type="button" onClick={confirmIngredient} disabled={!pickIngredient || (pickAmountMode === 'absolute' && !pickQuantity)} className="px-3 py-2 bg-primary text-white rounded-lg text-xs font-bold disabled:opacity-40">{t('editors.insert')}</button>
          {hiddenCount > 0 && !showUsedUp && (
            <button
              type="button"
              onClick={() => setShowUsedUp(true)}
              className="w-full text-left text-[10px] font-bold text-zinc-400 dark:text-zinc-500 hover:text-primary"
            >
              {t('editors.showUsedUp', { count: hiddenCount })}
            </button>
          )}
          {pickAmountMode === 'absolute' && selectedIngredient && (() => {
            const left = remainingForPicked();
            if (left === null) return null;
            return (
              <button
                type="button"
                onClick={() => setPickQuantity(Number(left.toFixed(2)))}
                className="w-full text-left text-[10px] font-bold text-primary hover:underline"
              >
                {t('editors.remainingAtThisStep', { amount: amountText(left, selectedIngredient.unitSymbol) })}
              </button>
            );
          })()}
        </div>
      )}

      {popover === 'tool' && (
        <div className="flex items-end gap-2 mb-2 bg-amber-50 border border-amber-100 rounded-xl p-3 flex-wrap">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.tool')}</label>
            <Autocomplete
              value={pickTool}
              options={tools.map(tool => ({ id: tool.id, label: tool.name }))}
              onSelect={(id) => { setPickTool(id); setPickToolAlias(''); }}
              onClear={() => { setPickTool(''); setPickToolAlias(''); }}
              placeholder={t('editors.search')}
              className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-amber-500/20 text-sm font-bold"
            />
          </div>
          <div className="flex-1 min-w-[150px]">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.showAs')}</label>
            <input
              type="text" list="step-tool-aliases" value={pickToolAlias}
              onChange={e => setPickToolAlias(e.target.value)}
              placeholder={selectedTool?.name || t('editors.showAsPlaceholder')}
              className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-amber-500/20 text-sm font-bold"
            />
            {aliasDatalist('step-tool-aliases', [selectedTool?.name || '', ...(selectedTool?.aliases ?? [])])}
          </div>
          <button type="button" onClick={confirmTool} disabled={!pickTool} className="px-3 py-2 bg-amber-500 text-white rounded-lg text-xs font-bold disabled:opacity-40">{t('editors.insert')}</button>
        </div>
      )}

      {popover === 'technique' && (
        <div className="flex items-end gap-2 mb-2 bg-sky-50 border border-sky-100 rounded-xl p-3 flex-wrap">
          <div className="flex-1 min-w-[150px]">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.technique')}</label>
            <Autocomplete
              value={pickTechnique}
              options={techniques.map(tech => ({ id: tech.id, label: tech.name }))}
              onSelect={(id) => { setPickTechnique(id); setPickTechniqueAlias(''); }}
              onClear={() => { setPickTechnique(''); setPickTechniqueAlias(''); }}
              placeholder={t('editors.search')}
              className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-sky-500/20 text-sm font-bold"
            />
          </div>
          <div className="flex-1 min-w-[150px]">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.showAs')}</label>
            <input
              type="text" list="step-tech-aliases" value={pickTechniqueAlias}
              onChange={e => setPickTechniqueAlias(e.target.value)}
              placeholder={selectedTechnique?.name || t('editors.showAsPlaceholder')}
              className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-sky-500/20 text-sm font-bold"
            />
            {aliasDatalist('step-tech-aliases', [selectedTechnique?.name || '', ...(selectedTechnique?.aliases ?? [])])}
          </div>
          <div className="flex-1 min-w-[150px]">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.detailsOptional')}</label>
            <input type="text" value={pickParams} onChange={e => setPickParams(e.target.value)}
              placeholder={t('editors.detailsPlaceholder')}
              className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-sky-500/20 text-sm font-bold" />
          </div>
          <button type="button" onClick={confirmTechnique} disabled={!pickTechnique} className="px-3 py-2 bg-sky-500 text-white rounded-lg text-xs font-bold disabled:opacity-40">{t('editors.insert')}</button>
        </div>
      )}

      <AutoTextarea
        ref={textareaRef}
        value={description}
        onChange={e => onChangeDescription(e.target.value)}
        className="w-full border-none bg-white dark:bg-zinc-900 rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[80px] max-h-[60vh] overflow-y-auto"
        placeholder={t('editors.describeStep')}
      />

      {description.includes('{{') && (
        <div className="mt-2 px-4 py-3 bg-zinc-50 dark:bg-zinc-900 rounded-xl text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          <RenderStepText text={description} ingredients={previewIngredients} tools={tools} techniques={techniques} />
        </div>
      )}
    </div>
  );
}
