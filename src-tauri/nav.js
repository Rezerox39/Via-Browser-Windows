(function() {
  if (document.getElementById('via-floating-nav')) return;
  var nav = document.createElement('div');
  nav.id = 'via-floating-nav';
  nav.innerHTML = '<button id="vn-back" title="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 18l-6-6 6-6"/></svg></button><button id="vn-fwd" title="Forward"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18l6-6-6-6"/></svg></button><button id="vn-home" title="Home"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/></svg></button><button id="vn-tabs" title="Tabs"><span id="vn-count">1</span></button><button id="vn-menu" title="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>';

  var css = document.createElement('style');
  css.textContent = '#via-floating-nav{position:fixed!important;bottom:20px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;display:flex!important;height:56px!important;min-width:340px!important;max-width:90vw!important;background:rgba(16,16,16,0.7)!important;backdrop-filter:blur(24px)!important;-webkit-backdrop-filter:blur(24px)!important;border:1px solid rgba(255,255,255,0.08)!important;border-radius:28px!important;box-shadow:0 8px 32px rgba(0,0,0,0.5)!important;padding:0 4px!important;align-items:stretch!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;user-select:none!important;-webkit-user-select:none!important}#via-floating-nav button{flex:1!important;display:flex!important;align-items:center!important;justify-content:center!important;color:#a0a0a0!important;background:none!important;border:none!important;cursor:pointer!important;border-radius:20px!important;padding:0!important;transition:color 0.15s ease,background 0.15s ease!important}#via-floating-nav button:hover{color:#fff!important;background:rgba(255,255,255,0.1)!important}#via-floating-nav button:active{background:rgba(255,255,255,0.18)!important}#via-floating-nav button:disabled{opacity:0.3!important;pointer-events:none!important}#via-floating-nav svg{width:22px!important;height:22px!important;flex-shrink:0!important}#vn-count{display:flex!important;align-items:center!important;justify-content:center!important;min-width:26px!important;height:20px!important;border:1.5px solid currentColor!important;border-radius:5px!important;font-size:11px!important;font-weight:700!important;color:#fff!important;padding:0 4px!important}';
  document.head.appendChild(css);
  document.body.appendChild(nav);

  // Back
  document.getElementById('vn-back').addEventListener('click', function(e) {
    e.stopPropagation();
    try { history.back(); } catch(ex) {}
  });
  // Forward
  document.getElementById('vn-fwd').addEventListener('click', function(e) {
    e.stopPropagation();
    try { history.forward(); } catch(ex) {}
  });
  // Home -> navigate to via-action scheme so parent handles it
  document.getElementById('vn-home').addEventListener('click', function(e) {
    e.stopPropagation();
    window.location.href = 'via-action://home';
  });
  // Tabs
  document.getElementById('vn-tabs').addEventListener('click', function(e) {
    e.stopPropagation();
    window.location.href = 'via-action://tabs';
  });
  // Menu
  document.getElementById('vn-menu').addEventListener('click', function(e) {
    e.stopPropagation();
    window.location.href = 'via-action://menu';
  });

  // Drag behavior
  var dragging = false, startY = 0, startBottom = 20;
  nav.addEventListener('mousedown', function(e) {
    if (e.target.closest('button')) return;
    dragging = true;
    startY = e.clientY;
    startBottom = parseInt(nav.style.bottom) || 20;
    e.preventDefault();
  });
  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    var delta = startY - e.clientY;
    var maxB = window.innerHeight - 70;
    var newBottom = Math.max(10, Math.min(maxB, startBottom + delta));
    nav.style.bottom = newBottom + 'px';
  });
  document.addEventListener('mouseup', function() { dragging = false; });
})();
