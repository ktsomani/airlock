const css = `
* { box-sizing: border-box; }
body { margin: 0; background: #e5ebe0; color: #1b3028; font: 14px/1.45 system-ui, sans-serif; }
.sheet { min-height: 500px; padding: clamp(18px,7%,40px); }
.mast { font-size: 12px; letter-spacing: .13em; border-bottom: 1px solid #819587; padding-bottom: 12px; }
.kicker { font: 10px monospace; letter-spacing: .15em; margin: 23px 0 7px; }
h1 { font-weight: 650; font-size: clamp(25px,7vw,35px); line-height: 1.04; letter-spacing: -.06em; margin: 0; }
.description { color: #42564c; margin: 10px 0 14px; font-size: 12px; }
.field { position: relative; height: 150px; border-radius: 6px; overflow: hidden; background: #ccd7c4; }
.contours { position: absolute; inset: -45% -20%; transform: rotate(-18deg); background: repeating-radial-gradient(ellipse at 48% 58%,transparent 0 11px,#62817170 12px 13px,transparent 14px 22px); }
.route { position: absolute; left: 16%; top: 58%; width: 34%; height: 3px; transform: rotate(-23deg); background-color: #886142; border-radius: 6px; }
.pin { position: absolute; left: 51%; top: 45%; display: grid; place-items: center; width: 31px; height: 31px; border: 1px solid #243e32; border-radius: 50%; background-color: #eac29e; font: bold 11px monospace; }
.legend { margin-top: 11px; display: flex; justify-content: space-between; font: 9px monospace; letter-spacing: .05em; }
.card { margin-top: 17px; padding: 10px 12px; border: 1px solid #9eac9d; border-radius: 6px; background: #edf0e5; }
.tag { display: inline-block; padding: 4px 8px; border-radius: 4px; background-color: #e4d3ac; font: 10px monospace; }
.extra { border-top: 1px solid #a1afa0; margin-top: 30px; padding-top: 9px; font-size: 11px; }
`;
const proposal = `
.route { left: 21%; width: 44%; transform: rotate(-15deg); background-color: #367757; }
.pin { left: 64%; top: 37%; background-color: #b9e2a8; }
.tag { border-radius: 18px; background-color: #c6ddbd; }
`;
const markup = `<article class="sheet">
<div class="mast" data-merge-state-id="mast">FIELD OFFICE</div>
<p class="kicker">ROUTE BRIEF / 04</p>
<h1>North ridge transect</h1>
<p class="description">A survey route through the eastern watershed.</p>
<div class="field"><div class="contours"></div><div class="route" data-merge-state-id="route"></div><div class="pin" data-merge-state-id="pin">04</div></div>
<div class="legend"><span>34.2° N / 118.1° W</span><span>500 M</span></div>
<div class="card"><span class="tag" data-merge-state-id="tag">ACCESS WINDOW</span></div>
<p class="extra">Survey conditions · Visibility good, light winds.</p>
</article>`;
const property = (name, before, after, previousRule, rule) => ({ name, before, after, previousRule, rule });
export const sample = {
  id: 'FO-042', title: 'Ridge route adjustment', source: 'Sample review',
  before: { html: markup, css }, proposed: { html: markup, css: css + proposal },
  changes: [
    { id: 'route', label: 'Route segment', properties: [
      property('left', '16%', '21%', '.route { left: 16%; }', '.route { left: 21%; }'),
      property('width', '34%', '44%', '.route { width: 34%; }', '.route { width: 44%; }'),
      property('transform', 'rotate(-23deg)', 'rotate(-15deg)', '.route { transform: rotate(-23deg); }', '.route { transform: rotate(-15deg); }'),
      property('background-color', '#886142', '#367757', '.route { background-color: #886142; }', '.route { background-color: #367757; }'),
    ] },
    { id: 'pin', label: 'Waypoint marker', properties: [
      property('left', '51%', '64%', '.pin { left: 51%; }', '.pin { left: 64%; }'),
      property('top', '45%', '37%', '.pin { top: 45%; }', '.pin { top: 37%; }'),
      property('background-color', '#eac29e', '#b9e2a8', '.pin { background-color: #eac29e; }', '.pin { background-color: #b9e2a8; }'),
    ] },
    { id: 'tag', label: 'Access window label', properties: [
      property('border-radius', '4px', '18px', '.tag { border-radius: 4px; }', '.tag { border-radius: 18px; }'),
      property('background-color', '#e4d3ac', '#c6ddbd', '.tag { background-color: #e4d3ac; }', '.tag { background-color: #c6ddbd; }'),
    ] },
  ],
};
