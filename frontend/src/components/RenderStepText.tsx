import React from 'react';

export interface StepTextIngredientCtx {
  sortOrder: number;
  name: string;
  quantity: string; // already formatted/scaled, e.g. "150 g"
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

// Inline reference tokens embedded in a step's free-text description:
//   {{ing:<sortOrder>}}          — a recipe ingredient, by its position in the ingredient list
//   {{tool:<toolId>}}            — a kitchen tool
//   {{tech:<techniqueId>|params}} — a cooking technique, with optional free-text params (e.g. "10 min/180°C")
const TOKEN_RE = /\{\{(ing|tool|tech):([^}|]+)(?:\|([^}]*))?\}\}/g;

const BADGE_STYLE: Record<string, string> = {
  ing: 'text-primary decoration-primary',
  tool: 'text-amber-600 decoration-amber-500',
  tech: 'text-sky-600 decoration-sky-500',
};

/** Expands {{ing:N}} / {{tool:id}} / {{tech:id|params}} tokens into bold, underlined inline references. */
export default function RenderStepText({ text, ingredients, tools, techniques }: RenderStepTextProps) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const [, type, id, params] = match;
    let label = '';
    if (type === 'ing') {
      const ing = ingredients.find(i => String(i.sortOrder) === id);
      label = ing ? `${ing.quantity ? ing.quantity + ' ' : ''}${ing.name}` : '[ingredient]';
    } else if (type === 'tool') {
      const tool = tools.find(t => t.id === id);
      label = tool?.name || '[tool]';
    } else {
      const tech = techniques.find(t => t.id === id);
      label = (tech?.name || '[technique]') + (params ? ` (${params})` : '');
    }
    parts.push(
      <strong key={key++} className={`font-bold underline decoration-2 underline-offset-2 ${BADGE_STYLE[type]}`}>
        {label}
      </strong>
    );
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}
