import React from 'react';
import { STEP_REF_RE, parseRefParams } from '../lib/stepRefs';

export interface StepTextIngredientCtx {
  sortOrder: number;
  name: string;
  /** The recipe's total for this ingredient, already formatted/scaled, e.g. "620 g". */
  quantity: string;
  /** What the step this text belongs to actually uses, already formatted
   *  and scaled — the amount a reference prints when the step pins one.
   *  Undefined when the step doesn't single this ingredient out. */
  stepQuantity?: string;
}

export interface StepTextToolCtx {
  id: string;
  name: string;
}

export interface StepTextTechniqueCtx {
  id: string;
  name: string;
}

interface RenderStepTextProps {
  text: string;
  ingredients: StepTextIngredientCtx[];
  tools: StepTextToolCtx[];
  techniques: StepTextTechniqueCtx[];
}

const BADGE_STYLE: Record<string, string> = {
  ing: 'text-primary decoration-primary',
  tool: 'text-tool decoration-tool/70',
  tech: 'text-technique decoration-technique/70',
};

/** Expands {{ing:N}} / {{tool:id}} / {{tech:id|params}} tokens into bold,
 *  underlined inline references — see lib/stepRefs.ts for the grammar.
 *
 *  An ingredient reference prints, in order of preference: the amount the
 *  token itself pins (`q=`), then the amount the step's own stepIngredients
 *  row says it uses, then the recipe's total. The middle one is what makes
 *  "500 g of the 620 g of flour" read as 500 g here and 120 g three steps
 *  later; the total is only the fallback for a step that never said how
 *  much it wanted. */
export default function RenderStepText({ text, ingredients, tools, techniques }: RenderStepTextProps) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  STEP_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STEP_REF_RE.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const [, type, rawId, rawParams] = match;
    const id = rawId.trim();
    const params = parseRefParams(rawParams);
    let label = '';
    if (type === 'ing') {
      const ing = ingredients.find(i => String(i.sortOrder) === id);
      const name = params.alias || ing?.name || '[ingredient]';
      const amount = params.amount !== undefined ? params.amount : (ing?.stepQuantity ?? ing?.quantity ?? '');
      label = `${amount ? amount + ' ' : ''}${name}`;
    } else if (type === 'tool') {
      const tool = tools.find(t => t.id === id);
      label = params.alias || tool?.name || '[tool]';
    } else {
      const tech = techniques.find(t => t.id === id);
      label = (params.alias || tech?.name || '[technique]') + (params.free ? ` (${params.free})` : '');
    }
    parts.push(
      <strong key={key++} className={`font-bold underline decoration-2 underline-offset-2 ${BADGE_STYLE[type]}`}>
        {label}
      </strong>
    );
    lastIndex = STEP_REF_RE.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}
