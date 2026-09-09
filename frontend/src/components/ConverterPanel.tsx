import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { Field, FormSection } from './Form';
import {
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  celsiusToGasMark,
  roundOvenTemperature,
  tinScaleFactor,
  tinAreaCm2,
  COMMON_TINS,
  type Tin,
} from '../lib/unitConvert';

/** The two conversions a recipe cannot do for you, because they are about
 *  your kitchen rather than the recipe: what your oven dial says, and what
 *  tin you actually own.
 *
 *  Ingredient amounts are NOT here — those convert in place on the recipe
 *  itself via the metric/imperial toggle, which is where you are already
 *  looking. */
export default function ConverterPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [celsius, setCelsius] = useState('180');
  const [fromTin, setFromTin] = useState(2); // 20 cm round
  const [toTin, setToTin] = useState(3); // 23 cm round

  const c = Number.parseFloat(celsius.replace(',', '.'));
  const validC = Number.isFinite(c);
  const f = validC ? roundOvenTemperature(celsiusToFahrenheit(c)) : null;
  const gas = validC ? celsiusToGasMark(c) : null;

  const from: Tin = COMMON_TINS[fromTin].tin;
  const to: Tin = COMMON_TINS[toTin].tin;
  const factor = tinScaleFactor(from, to);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={t('converter.title')}
      subtitle={t('converter.subtitle')}
    >
      <div className="space-y-8">
        <FormSection title={t('converter.oven')}>
          <div className="grid grid-cols-3 gap-3">
            <Field label="°C">
              <input
                type="number"
                inputMode="decimal"
                value={celsius}
                onChange={(e) => setCelsius(e.target.value)}
                className="sc-field text-center"
              />
            </Field>
            <Field label="°F">
              {/* Read-only rather than a second input: two-way binding here
                  fights the user mid-keystroke, and the oven dial is the
                  thing being looked up, not edited. */}
              <output className="sc-field block text-center tabular-nums">
                {f ?? '—'}
              </output>
            </Field>
            <Field label={t('converter.gasMark')}>
              <output className="sc-field block text-center tabular-nums">
                {gas ?? '—'}
              </output>
            </Field>
          </div>
          {validC && !gas && (
            <p className="sc-hint">{t('converter.outsideGasRange')}</p>
          )}
        </FormSection>

        <FormSection title={t('converter.tin')} description={t('converter.tinHint')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('converter.recipeUses')}>
              <select value={fromTin} onChange={(e) => setFromTin(Number(e.target.value))} className="sc-field cursor-pointer">
                {COMMON_TINS.map((entry, i) => <option key={entry.label} value={i}>{entry.label}</option>)}
              </select>
            </Field>
            <Field label={t('converter.youHave')}>
              <select value={toTin} onChange={(e) => setToTin(Number(e.target.value))} className="sc-field cursor-pointer">
                {COMMON_TINS.map((entry, i) => <option key={entry.label} value={i}>{entry.label}</option>)}
              </select>
            </Field>
          </div>

          <div className="sc-panel flex items-center gap-4 p-4">
            <span className="text-3xl font-black tabular-nums text-primary">
              {factor ? `×${factor}` : '—'}
            </span>
            <p className="sc-hint flex-1">
              {factor
                ? t('converter.tinResult', {
                    pct: Math.round(Math.abs(factor - 1) * 100),
                    direction: factor >= 1 ? t('converter.more') : t('converter.less'),
                    a: Math.round(tinAreaCm2(from)),
                    b: Math.round(tinAreaCm2(to)),
                  })
                : t('converter.tinInvalid')}
            </p>
          </div>
        </FormSection>
      </div>
    </Modal>
  );
}
