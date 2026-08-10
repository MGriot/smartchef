import React, { useState } from 'react';
import AppLayout from '../components/AppLayout';

export default function RecipeImport() {
  const [sourceType, setSourceType] = useState<'url' | 'text'>('text');
  const [inputVal, setInputVal] = useState('');
  const [parsing, setParsing] = useState(false);

  const handleStartImport = () => {
    setParsing(true);
    // Simulation
    setTimeout(() => setParsing(false), 2000);
  };

  return (
    <AppLayout>
      <div className="p-12 max-w-6xl mx-auto">
          <div className="mb-12">
            <h1 className="text-6xl font-black text-zinc-900 tracking-tighter mb-4">Smart Import</h1>
            <p className="text-zinc-500 text-lg max-w-xl leading-relaxed">
              Paste a link or raw recipe notes. Our Culinary AI will transform it into a perfectly formatted masterpiece.
            </p>
          </div>

          <div className="grid grid-cols-12 gap-10">
            {/* Input Form */}
            <div className="col-span-12 lg:col-span-7">
              <div className="bg-white rounded-[40px] shadow-sm border border-zinc-100 overflow-hidden">
                <div className="p-8 border-b border-zinc-50 flex justify-between items-center">
                   <h3 className="text-[10px] font-black text-primary tracking-[0.2em] uppercase">Source Material</h3>
                   <div className="flex bg-zinc-100 p-1 rounded-xl">
                      <button 
                        onClick={() => setSourceType('url')}
                        className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${sourceType === 'url' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-400'}`}
                      >URL</button>
                      <button 
                         onClick={() => setSourceType('text')}
                         className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${sourceType === 'text' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-400'}`}
                      >Raw Text</button>
                   </div>
                </div>
                <div className="p-10">
                  <textarea 
                    value={inputVal}
                    onChange={(e) => setInputVal(e.target.value)}
                    placeholder={sourceType === 'url' ? "https://cooking.nytimes.com/recipes/..." : "Mom's Famous Lasagna\nPrep time: 20 mins, Cook: 45 mins.\nServes 6.\n\nIngredients:\n- 1 lb ground beef..."}
                    className="w-full h-80 bg-zinc-50/50 rounded-3xl border-none focus:ring-2 focus:ring-primary/10 text-zinc-700 font-medium leading-relaxed resize-none p-6 hide-scrollbar"
                  />
                  <button 
                    onClick={handleStartImport}
                    disabled={parsing || !inputVal}
                    className="mt-8 w-full py-5 bg-gradient-to-r from-primary to-primary-container text-white rounded-3xl font-black text-lg shadow-xl shadow-primary/20 flex items-center justify-center gap-3 hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-50 disabled:scale-100"
                  >
                    <span className={`material-symbols-outlined ${parsing ? 'animate-spin' : ''}`}>
                      {parsing ? 'settings' : 'auto_fix_high'}
                    </span>
                    {parsing ? 'Analyzing Ingredients...' : 'Start AI Transformation'}
                  </button>
                </div>
              </div>
            </div>

            {/* Sidebar Stats & Preview */}
            <div className="col-span-12 lg:col-span-5 space-y-8">
               {/* AI Status */}
               <div className="bg-white rounded-[40px] p-8 shadow-sm border border-zinc-100 relative overflow-hidden group">
                  <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                  <div className="relative z-10 flex flex-col items-center text-center">
                     <div className="w-16 h-16 rounded-full bg-white shadow-xl flex items-center justify-center mb-6 relative">
                        <span className="material-symbols-outlined text-primary text-3xl animate-pulse">model_training</span>
                        <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping"></div>
                     </div>
                     <h3 className="text-2xl font-black text-zinc-900 mb-2">Culinary AI Active</h3>
                     <p className="text-primary font-bold text-xs tracking-tight mb-8">Analyzing ingredients & mapping steps...</p>
                     
                     <div className="w-full h-1 bg-zinc-100 rounded-full overflow-hidden mb-4">
                        <div className="h-full bg-primary" style={{ width: parsing ? '45%' : '0%', transition: 'width 2s ease-in-out' }}></div>
                     </div>

                     <div className="flex justify-between w-full">
                        <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Confidence Score</p>
                        <p className="text-[10px] font-black text-primary uppercase tracking-widest">95% High</p>
                     </div>
                  </div>
               </div>

               {/* Result Preview */}
               <div className="bg-white rounded-[40px] overflow-hidden shadow-xl shadow-zinc-200/50 border border-zinc-100 group">
                  <div className="h-64 relative overflow-hidden">
                     <img 
                        src="https://images.unsplash.com/photo-1551183053-bf91a1d81141?auto=format&fit=crop&q=80&w=800" 
                        alt="Lasagna Preview" 
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700"
                     />
                     <div className="absolute inset-0 bg-gradient-to-t from-zinc-900 via-transparent to-transparent"></div>
                     <div className="absolute bottom-6 left-6">
                        <p className="text-[10px] font-black text-white/60 uppercase tracking-widest mb-1">Previewing...</p>
                        <h4 className="text-2xl font-black text-white leading-tight">Mom's Famous Lasagna</h4>
                     </div>
                  </div>
                  <div className="p-8">
                     <div className="flex gap-8 mb-8">
                        <div>
                           <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Servings</p>
                           <p className="text-sm font-black text-zinc-900 tracking-tight">6 People</p>
                        </div>
                        <div>
                           <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Prep Time</p>
                           <p className="text-sm font-black text-zinc-900 tracking-tight">20 Mins</p>
                        </div>
                     </div>
                     <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-4">Ingredients Detected</p>
                     <div className="flex flex-wrap gap-2">
                        {['Ground Beef', 'Ricotta', 'Marinara', '+4 more'].map(tag => (
                           <span key={tag} className="px-3 py-1 bg-zinc-100 rounded-lg text-[10px] font-bold text-zinc-500 uppercase">{tag}</span>
                        ))}
                     </div>
                  </div>
               </div>
            </div>
          </div>
      </div>
    </AppLayout>
  );
}
