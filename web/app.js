/* Ranking matches src/recommender.py; the watched log stays in this browser. */
(function () {
  'use strict';
  const data = window.MOVIE_NIGHT;
  const $ = id => document.getElementById(id);
  if (!data || !Array.isArray(data.movies)) {
    $('load-status').textContent = 'The catalog could not load. Extract the full folder and open web/index.html again.';
    return;
  }
  const movies = data.movies;
  const lookup = new Map(movies.map((movie, index) => [movie.id, index]));
  const storageKey = 'movie-night-profile-v1';
  const state = { ratings:new Map(), watched:new Map(), genre:'', count:5, hasResults:false, view:'find', isExample:false, watchedQuery:'', watchedGenre:'', watchedSort:'recent' };
  const searches = [];
  let undoAction = null, toastTimer = null;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const searchTitles = movies.map(movie => normalize(movie.title));
  const decodeId = value => /^\d+$/.test(value) ? Number(value) : value;
  const plainTitle = movie => movie.title.replace(/\s*\(\d{4}\)\s*$/,'').trim();
  const ratingLabels = {0:'Not rated',1:"Didn't like it",2:'Not for me',3:'It was okay',4:'Liked it',5:'Loved it'};
  const genres = [...new Set(movies.flatMap(movie => movie.genres))].sort();

  function catalogRecord(id, rating=0, addedAt=new Date().toISOString()) {
    const movie = movies[lookup.get(id)];
    return {id, title:movie.title, year:movie.year, genres:[...movie.genres], rating, addedAt};
  }
  function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null; }
  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({version:2, ratings:[...state.ratings], watched:[...state.watched.values()], seen:[...state.watched.keys()].filter(id => typeof id === 'number'), genre:state.genre, count:state.count, hasResults:state.hasResults, view:state.view, isExample:state.isExample}));
      $('storage-warning').hidden = true;
    } catch (_) { $('storage-warning').hidden = false; }
  }
  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!saved || typeof saved !== 'object') return;
      for (const pair of (Array.isArray(saved.ratings) ? saved.ratings : []).slice(0,10)) {
        if (Array.isArray(pair) && lookup.has(pair[0]) && Number.isInteger(pair[1]) && pair[1] >= 0 && pair[1] <= 5) state.ratings.set(pair[0],pair[1]);
      }
      if (Array.isArray(saved.watched)) {
        for (const item of saved.watched) {
          if (!item || typeof item !== 'object') continue;
          const rating = Number.isInteger(item.rating) && item.rating >= 0 && item.rating <= 5 ? item.rating : 0;
          if (typeof item.id === 'number' && lookup.has(item.id)) state.watched.set(item.id,catalogRecord(item.id,rating,validDate(item.addedAt)));
          else if (typeof item.id === 'string' && /^custom-[a-z0-9-]+$/i.test(item.id) && typeof item.title === 'string' && item.title.trim()) {
            state.watched.set(item.id,{id:item.id,title:item.title.slice(0,200),year:Number.isInteger(item.year) ? item.year : null,genres:Array.isArray(item.genres) ? item.genres.filter(genre => typeof genre === 'string').slice(0,5) : [],rating,addedAt:validDate(item.addedAt)});
          }
        }
      } else if (Array.isArray(saved.seen)) {
        // Earlier versions saved only IDs. Preserve them without inventing dates.
        for (const id of saved.seen) if (lookup.has(id)) state.watched.set(id,catalogRecord(id,state.ratings.get(id) || 0,null));
      }
      state.genre = genres.includes(saved.genre) ? saved.genre : '';
      state.count = saved.count === 10 ? 10 : 5;
      state.hasResults = !!saved.hasResults;
      state.view = saved.view === 'watched' ? 'watched' : 'find';
      state.isExample = !!saved.isExample;
    } catch (_) { /* An unreadable saved profile leaves the picker usable. */ }
  }
  function validRatings() { return new Map([...state.ratings].filter(([,rating]) => rating >= 1)); }
  function ready() { const values = validRatings(); return values.size >= 3 && [...values.values()].some(rating => rating >= 4); }

  function rankCandidates(preferences, genre='', limit=10, excluded=new Set()) {
    const affinity = new Float64Array(movies.length), evidence = new Float64Array(movies.length);
    const reasons = new Int32Array(movies.length).fill(-1);
    let weightSum = 0;
    for (const [id,rating] of preferences) {
      const index = lookup.get(Number(id));
      if (index === undefined) continue;
      const weight = (Number(rating)-3)/2;
      weightSum += Math.abs(weight);
      for (const [neighbor,similarity] of movies[index].neighbors) {
        const value = weight*similarity;
        affinity[neighbor] += value;
        if (weight > 0 && value > evidence[neighbor]) { evidence[neighbor]=value; reasons[neighbor]=Number(id); }
      }
    }
    const result=[];
    for (let index=0; index<movies.length; index++) {
      const movie=movies[index];
      if (movie.ratingCount<10 || preferences.has(movie.id) || excluded.has(movie.id) || (genre && !movie.genres.includes(genre))) continue;
      result.push({id:movie.id,score:(weightSum ? affinity[index]/weightSum : 0)+data.qualityWeight*movie.quality,reasonId:evidence[index]>0 ? reasons[index] : null});
    }
    result.sort((a,b) => b.score-a.score || a.id-b.id);
    return result.slice(0,limit);
  }

  function notify(message, undo=null) {
    clearTimeout(toastTimer); undoAction=undo;
    $('toast-message').textContent=message; $('toast-undo').hidden=!undo; $('toast').hidden=false;
    toastTimer=setTimeout(() => { $('toast').hidden=true; undoAction=null; },8500);
  }
  function setView(view, focus=false) {
    state.view=view;
    $('finder-panel').hidden=view!=='find'; $('watched-panel').hidden=view!=='watched';
    for (const [id,selected] of [['find-tab',view==='find'],['watched-tab',view==='watched']]) {
      $(id).setAttribute('aria-selected',String(selected)); $(id).tabIndex=selected ? 0 : -1;
    }
    searches.forEach(search => search.close());
    if (focus) $(view==='find' ? 'find-tab' : 'watched-tab').focus();
    save();
  }
  function stars(id,rating,title,kind) {
    return [1,2,3,4,5].map(value => `<button class="star ${value<=rating ? 'filled' : ''}" ${kind==='profile' ? `data-movie="${id}" data-rating="${value}"` : `data-watch-id="${id}" data-watch-rating="${value}"`} type="button" aria-label="Rate ${escape(title)} ${value} out of 5 stars" aria-pressed="${value===rating}">${value<=rating ? '★' : '☆'}</button>`).join('');
  }
  function stub(movie) {
    const words=plainTitle(movie).split(/\s+/).filter(word => !/^(the|a|an)$/i.test(word));
    const initials=words.slice(0,2).map(word => word[0]).join('').toUpperCase() || 'MN';
    const tone=movie.genres.includes('Animation') ? 'animation' : movie.genres.includes('Sci-Fi') ? 'scifi' : movie.genres.includes('Horror') ? 'horror' : movie.genres.includes('Comedy') ? 'comedy' : 'drama';
    return `<div class="film-stub tone-${tone}" aria-hidden="true"><span class="stub-top">${movie.year || 'FILM'}</span><b>${escape(initials)}</b><span class="stub-bottom">Movie Night</span></div>`;
  }
  function renderProfile() {
    $('examples').hidden=state.ratings.size>0;
    $('rated-movies').innerHTML=!state.ratings.size ? '<p class="empty-profile">A few familiar films are all you need.</p>' : [...state.ratings].map(([id,rating]) => {
      const movie=movies[lookup.get(id)];
      return `<div class="rated-movie"><div class="movie-line"><span class="movie-title">${escape(movie.title)}</span><button class="remove" type="button" data-remove="${id}" aria-label="Remove ${escape(movie.title)} from ratings">×</button></div><p class="genres">${escape(movie.genres.slice(0,3).join(' / '))}</p><div class="rating-row">${stars(id,rating,movie.title,'profile')}<span class="rating-label">${rating ? ratingLabels[rating] : 'Choose a rating'}</span></div>${state.watched.has(id) ? '<div class="watched-tick">✓ In your watched list</div>' : ''}</div>`;
    }).join('');
    const count=validRatings().size;
    $('recommend').disabled=!ready();
    $('recommend').innerHTML=(state.hasResults ? 'Refresh my picks' : 'Find my next film')+' <span aria-hidden="true">→</span>';
    $('profile-status').textContent=count<3 ? `${count} of 3 movies rated.` : !ready() ? 'Include at least one film you rated 4 or 5 stars.' : `${count} films rated. You're ready.`;
  }
  function renderRecommendations() {
    if (!state.hasResults || !ready()) {
      $('result-status').textContent='';
      $('recommendation-list').innerHTML='<li class="empty-results"><b>What sounds good tonight?</b><p>Rate three films to start, or load a sample taste on the left.</p></li>';
      return;
    }
    const excluded=new Set([...state.watched.keys(),...state.ratings.keys()]);
    const picks=rankCandidates(validRatings(),state.genre,state.count,excluded);
    $('result-status').textContent=picks.length ? `${picks.length} ${state.genre ? state.genre+' ' : ''}picks. Watched films are left out.` : 'No picks with these settings. Try another genre.';
    $('recommendation-list').innerHTML=picks.map((pick,index) => {
      const movie=movies[lookup.get(pick.id)];
      const reason=pick.reasonId!==null ? `Because you liked ${plainTitle(movies[lookup.get(pick.reasonId)])}.` : state.genre ? `A well-rated ${state.genre} pick.` : 'Well rated by MovieLens viewers.';
      return `<li class="recommendation" data-recommendation="${movie.id}">${stub(movie)}<div class="film-content"><p class="pick-number">PICK ${String(index+1).padStart(2,'0')}</p><h3><a href="https://movielens.org/movies/${movie.id}" target="_blank" rel="noopener noreferrer">${escape(plainTitle(movie))}</a></h3><p class="genres">${escape(movie.genres.slice(0,3).join(' / '))}</p><p class="reason">${escape(reason)}</p><button class="watch-button" type="button" data-seen="${movie.id}" aria-label="Mark ${escape(movie.title)} watched"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>Mark watched</button></div></li>`;
    }).join('');
  }
  function dateLabel(record) {
    return record.addedAt ? 'Added '+new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(new Date(record.addedAt)) : 'From your saved list';
  }
  function renderWatched() {
    const total=state.watched.size;
    $('watched-nav-count').textContent=String(total);
    $('export-watched').disabled=!total;
    let records=[...state.watched.values()].filter(movie => normalize(movie.title).includes(normalize(state.watchedQuery)) && (!state.watchedGenre || movie.genres.includes(state.watchedGenre)));
    const byRecent=(a,b) => (Date.parse(b.addedAt)||0)-(Date.parse(a.addedAt)||0) || a.title.localeCompare(b.title);
    records.sort(state.watchedSort==='title' ? (a,b) => a.title.localeCompare(b.title) : state.watchedSort==='rating' ? (a,b) => b.rating-a.rating || byRecent(a,b) : byRecent);
    $('watched-summary').textContent=!total ? 'A place for the films you’ve finished.' : records.length===total ? `${total} ${total===1 ? 'film' : 'films'} in your log.` : `${records.length} of ${total} films shown.`;
    if (!records.length) {
      $('watched-list').innerHTML=total ? '<div class="empty-log"><h3>No films match that search.</h3><p>Try a different title or genre.</p></div>' : '<div class="empty-log"><h3>Your film log starts here.</h3><p>Search for a film above, add one manually, or mark a recommendation watched.</p><button class="text-button" type="button" data-go-find>Find something to watch →</button></div>';
      return;
    }
    $('watched-list').innerHTML=records.map(movie => `<article class="watched-row" data-watched="${movie.id}">${stub(movie)}<div><h3>${escape(plainTitle(movie))}${movie.year ? ` <span class="muted small">(${movie.year})</span>` : ''}</h3><p class="genres">${escape(movie.genres.join(' / ') || 'Genre not set')}</p><span class="added-date">${escape(dateLabel(movie))}</span></div><div class="rating-row watch-rating">${stars(movie.id,movie.rating,movie.title,'watched')}<span class="rating-label">${ratingLabels[movie.rating]}</span></div><div class="watched-actions">${lookup.has(movie.id) ? `<button class="text-button" type="button" data-use="${movie.id}">Use for picks</button>` : ''}<button class="text-button" type="button" data-unwatch="${movie.id}" aria-label="Remove ${escape(movie.title)} from watched">Remove</button></div></article>`).join('');
  }
  function refresh() { renderProfile(); renderRecommendations(); renderWatched(); }

  function putWatched(id,rating) {
    const previous=state.watched.get(id);
    if (!previous) state.watched.set(id,catalogRecord(id,rating || state.ratings.get(id) || 0));
    else if (rating) state.watched.set(id,{...previous,rating});
    return previous;
  }
  function markWatched(id) {
    if (!lookup.has(id)) return;
    const previous=putWatched(id);
    save(); refresh();
    if (previous) notify('That film is already in Watched.');
    else notify(`Added ${plainTitle(movies[lookup.get(id)])} to Watched.`,() => { state.watched.delete(id); save(); refresh(); });
  }
  function removeWatched(id) {
    const previous=state.watched.get(id);
    if (!previous) return;
    state.watched.delete(id); save(); refresh();
    notify(`Removed ${plainTitle(previous)} from Watched.`,() => { state.watched.set(id,previous); save(); refresh(); });
  }
  function addMovie(id) {
    if (!lookup.has(id)) return;
    if (!state.ratings.has(id) && state.ratings.size>=10) { notify('Your taste profile holds up to 10 films. Remove one to add another.'); return; }
    if (!state.ratings.has(id)) state.ratings.set(id,state.watched.get(id)?.rating || 0);
    state.isExample=false; setView('find'); save(); refresh();
    document.querySelector(`button[data-movie="${id}"][data-rating="1"]`)?.focus();
  }

  function openManual(title='') {
    $('manual-form').reset();
    const year=title.match(/\((\d{4})\)\s*$/);
    $('manual-title').value=year ? title.replace(/\s*\(\d{4}\)\s*$/,'') : title;
    if (year) $('manual-year').value=year[1];
    $('manual-dialog').showModal(); $('manual-title').focus();
  }
  function setupSearch(inputId,listId,onPick,exclude=() => false) {
    const input=$(inputId), list=$(listId);
    let matches=[], active=-1;
    function close() { list.hidden=true; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant'); active=-1; }
    function show() {
      const query=normalize(input.value), tokens=query.split(' ').filter(Boolean);
      matches=movies.map((movie,index) => ({movie,index})).filter(({movie,index}) => !exclude(movie.id) && tokens.every(token => searchTitles[index].includes(token)))
        .sort((a,b) => Number(searchTitles[b.index].startsWith(query))-Number(searchTitles[a.index].startsWith(query)) || b.movie.ratingCount-a.movie.ratingCount).slice(0,8).map(item => item.movie);
      active=-1;
      list.innerHTML=matches.length ? matches.map((movie,index) => `<li role="presentation"><button type="button" role="option" id="${listId}-${index}" aria-selected="false" data-search-pick="${movie.id}">${escape(movie.title)}<small>${escape(movie.genres.slice(0,3).join(' / '))}${state.watched.has(movie.id) ? ' · Watched' : ''}</small></button></li>`).join('') : '<li class="no-search-results">No matching title in this catalog.<button type="button" data-search-manual>Add it to Watched manually</button></li>';
      list.hidden=false; input.setAttribute('aria-expanded','true');
    }
    function pick(id) { input.value=''; close(); onPick(id); }
    input.addEventListener('input',show);
    input.addEventListener('focus',() => { if (input.value) show(); });
    input.addEventListener('keydown',event => {
      if (event.key==='Escape') { event.preventDefault(); close(); return; }
      if ((event.key==='ArrowDown' || event.key==='ArrowUp') && list.hidden) show();
      if ((event.key==='ArrowDown' || event.key==='ArrowUp') && matches.length) {
        event.preventDefault(); active=(active+(event.key==='ArrowDown' ? 1 : -1)+matches.length)%matches.length;
        list.querySelectorAll('[role=option]').forEach((option,index) => { option.classList.toggle('active',index===active); option.setAttribute('aria-selected',String(index===active)); });
        input.setAttribute('aria-activedescendant',`${listId}-${active}`);
      } else if (event.key==='Enter' && matches.length && !list.hidden) { event.preventDefault(); pick(matches[active>=0 ? active : 0].id); }
    });
    list.addEventListener('click',event => {
      const button=event.target.closest('button[data-search-pick]');
      if (button) pick(Number(button.dataset.searchPick));
      else if (event.target.closest('[data-search-manual]')) { const title=input.value; close(); openManual(title); }
    });
    document.addEventListener('click',event => { if (!input.parentElement.contains(event.target)) close(); });
    const controller={close}; searches.push(controller); return controller;
  }

  for (const id of ['genre','watched-genre','manual-genre']) $(id).innerHTML+=genres.map(genre => `<option value="${escape(genre)}">${escape(genre)}</option>`).join('');
  $('manual-year').max=String(new Date().getFullYear()+1);
  restore();
  $('genre').value=state.genre; $('result-count').value=String(state.count);
  setupSearch('movie-search','search-results',addMovie,id => state.ratings.has(id));
  setupSearch('watched-add-search','watched-add-results',markWatched);
  $('find-tab').addEventListener('click',() => setView('find'));
  $('watched-tab').addEventListener('click',() => { setView('watched'); renderWatched(); });
  document.querySelector('.view-tabs').addEventListener('keydown',event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); setView(event.key==='Home' ? 'find' : event.key==='End' ? 'watched' : state.view==='find' ? 'watched' : 'find',true); } });
  $('example-buttons').innerHTML=data.examples.map((example,index) => `<button type="button" data-example="${index}">${escape(example.name)}</button>`).join('');
  $('example-buttons').addEventListener('click',event => {
    const button=event.target.closest('[data-example]'); if (!button) return;
    const example=data.examples[Number(button.dataset.example)];
    state.ratings=new Map(example.ratings.filter(item => lookup.has(item.id)).map(item => [item.id,item.rating]));
    state.genre={'Sci-fi':'Sci-Fi','Comedy':'Comedy','Animation':'Animation'}[example.name] || '';
    state.hasResults=true; state.isExample=true; $('genre').value=state.genre; save(); refresh();
  });
  $('rated-movies').addEventListener('click',event => {
    const remove=event.target.closest('[data-remove]'), star=event.target.closest('[data-rating]');
    if (remove) state.ratings.delete(Number(remove.dataset.remove));
    else if (star) { const id=Number(star.dataset.movie), rating=Number(star.dataset.rating); state.ratings.set(id,rating); putWatched(id,rating); state.isExample=false; }
    else return;
    save(); refresh();
    if (star) document.querySelector(`button[data-movie="${star.dataset.movie}"][data-rating="${star.dataset.rating}"]`)?.focus();
  });
  $('recommend').addEventListener('click',() => { if (ready()) { state.hasResults=true; save(); refresh(); if (innerWidth<760) document.querySelector('.recommendations')?.scrollIntoView({behavior:'smooth',block:'start'}); } });
  $('genre').addEventListener('change',() => { state.genre=$('genre').value; save(); renderRecommendations(); });
  $('result-count').addEventListener('change',() => { state.count=Number($('result-count').value); save(); renderRecommendations(); });
  $('recommendation-list').addEventListener('click',event => { const button=event.target.closest('[data-seen]'); if (button) markWatched(Number(button.dataset.seen)); });
  $('reset').addEventListener('click',() => { state.ratings.clear(); state.genre=''; state.count=5; state.hasResults=false; state.isExample=false; $('genre').value=''; $('result-count').value='5'; $('movie-search').value=''; searches.forEach(search => search.close()); save(); refresh(); notify('Taste profile cleared. Your watched list is safe.'); $('movie-search').focus(); });

  $('watched-filter').addEventListener('input',() => { state.watchedQuery=$('watched-filter').value; renderWatched(); });
  $('watched-genre').addEventListener('change',() => { state.watchedGenre=$('watched-genre').value; renderWatched(); });
  $('watched-sort').addEventListener('change',() => { state.watchedSort=$('watched-sort').value; renderWatched(); });
  $('watched-list').addEventListener('click',event => {
    const remove=event.target.closest('[data-unwatch]'), use=event.target.closest('[data-use]'), star=event.target.closest('[data-watch-rating]');
    if (remove) removeWatched(decodeId(remove.dataset.unwatch));
    else if (use) addMovie(Number(use.dataset.use));
    else if (star) {
      const id=decodeId(star.dataset.watchId), rating=Number(star.dataset.watchRating), record=state.watched.get(id);
      if (!record) return;
      state.watched.set(id,{...record,rating}); if (state.ratings.has(id)) state.ratings.set(id,rating);
      save(); refresh(); document.querySelector(`button[data-watch-id="${id}"][data-watch-rating="${rating}"]`)?.focus();
    } else if (event.target.closest('[data-go-find]')) setView('find');
  });
  $('manual-add').addEventListener('click',() => openManual());
  $('manual-close').addEventListener('click',() => $('manual-dialog').close());
  $('manual-form').addEventListener('submit',event => {
    event.preventDefault(); if (!$('manual-form').reportValidity()) return;
    let title=$('manual-title').value.trim(), year=$('manual-year').value ? Number($('manual-year').value) : null;
    if (!title) return;
    const embedded=title.match(/\((\d{4})\)\s*$/);
    if (embedded) { if (!year) year=Number(embedded[1]); title=title.replace(/\s*\(\d{4}\)\s*$/,'').trim(); }
    if (!title) { $('manual-title').value=''; $('manual-form').reportValidity(); return; }
    if (year && (year<1888 || year>Number($('manual-year').max))) { $('manual-year').value=String(year); $('manual-form').reportValidity(); return; }
    const rating=Number($('manual-rating').value), genre=$('manual-genre').value;
    const matching=movies.filter(movie => normalize(plainTitle(movie))===normalize(title) && (!year || movie.year===year));
    const catalog=matching.length===1 ? matching[0] : null;
    const previous=[...state.watched.values()].find(movie => normalize(plainTitle(movie))===normalize(title) && (!year || movie.year===year));
    if (previous) { $('manual-dialog').close(); setView('watched'); notify('That film is already in your watched list.'); return; }
    const id=catalog ? catalog.id : `custom-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const record=catalog ? catalogRecord(id,rating) : {id,title:title+(year ? ` (${year})` : ''),year,genres:genre ? [genre] : [],rating,addedAt:new Date().toISOString()};
    state.watched.set(id,record); if (state.ratings.has(id) && rating) state.ratings.set(id,rating);
    state.watchedQuery=''; state.watchedGenre=''; state.watchedSort='recent'; $('watched-filter').value=''; $('watched-genre').value=''; $('watched-sort').value='recent';
    $('manual-dialog').close(); setView('watched'); save(); refresh(); notify(`Added ${plainTitle(record)} to Watched.`,() => { state.watched.delete(id); save(); refresh(); });
  });
  $('export-watched').addEventListener('click',() => {
    function csv(value) { let text=String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text="'"+text; return '"'+text.replace(/"/g,'""')+'"'; }
    const rows=[['title','year','genres','rating','added_at'],...[...state.watched.values()].map(movie => [plainTitle(movie),movie.year || '',movie.genres.join(' | '),movie.rating || '',movie.addedAt || ''])];
    const blob=new Blob(['\uFEFF'+rows.map(row => row.map(csv).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url; link.download='movie-night-watched.csv'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
  });
  $('toast-undo').addEventListener('click',() => { const undo=undoAction; undoAction=null; $('toast').hidden=true; clearTimeout(toastTimer); if (undo) undo(); });
  $('toast-close').addEventListener('click',() => { $('toast').hidden=true; clearTimeout(toastTimer); undoAction=null; });
  window.MovieNight={rank:rankCandidates,data,getState:() => ({ratings:[...state.ratings],seen:[...state.watched.keys()].filter(id => typeof id==='number'),watched:[...state.watched.values()],genre:state.genre,view:state.view})};
  $('workspace').hidden=false; $('load-status').hidden=true; setView(state.view); refresh();
})();
