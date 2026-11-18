import React, { useState } from 'react';

export const OfficialBanner: React.FC = () => {
  const [selected, setSelected] = useState<'actionflow' | 'have2want'>('actionflow');

  return (
    <div className="w-full mb-4 rounded-2xl overflow-hidden border-2 border-amber-500/50 shadow-[0_6px_28px_rgba(0,0,0,0.7)] bg-[#F6F1EB]">
      {/* Barra di commutazione semplice */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#0b1220] border-b border-amber-500/30">
        <span className="text-[10px] font-bold text-amber-300 uppercase tracking-wider flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          Banner Ufficiale
        </span>
        <div className="flex items-center gap-1 bg-black/60 p-0.5 rounded-lg border border-slate-700">
          <button
            type="button"
            onClick={() => setSelected('actionflow')}
            className={`px-2 py-0.5 text-[11px] font-bold rounded transition-all ${
              selected === 'actionflow'
                ? 'bg-gradient-to-r from-amber-500 to-yellow-600 text-black shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            ActionFlow Hub
          </button>
          <button
            type="button"
            onClick={() => setSelected('have2want')}
            className={`px-2 py-0.5 text-[11px] font-bold rounded transition-all ${
              selected === 'have2want'
                ? 'bg-gradient-to-r from-amber-500 to-yellow-600 text-black shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Have2Want +
          </button>
        </div>
      </div>

      {/* Immagine del Banner a tutta larghezza */}
      <div className="w-full bg-[#F6F1EB] overflow-hidden">
        {selected === 'actionflow' ? (
          <img
            src="/actionflow_hub_banner.jpg"
            alt="ActionFlow Hub Banner"
            className="w-full h-auto object-contain block"
          />
        ) : (
          <img
            src="/have2want_plus_banner.jpg"
            alt="Have2Want + Banner"
            className="w-full h-auto object-contain block"
          />
        )}
      </div>
    </div>
  );
};
