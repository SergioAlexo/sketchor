/** The hero's "drawing in progress": a bracket outline with a selected edge, a snap marker and a dimension. */
export default function HeroCanvas() {
  const mono = "ui-monospace, monospace";
  return (
    <div className="canvas-frame">
      <div className="canvas-chrome">
        <span className="tab">bracket.dxf</span>
        <span className="spacer" />
        <span>128.40, 0.00</span>
        <span>100%</span>
      </div>
      <svg viewBox="0 0 640 400" role="img" aria-label="A bracket outline being drawn in Sketchor, with a selected edge, a snap marker and a dimension." className="draw">
        <defs>
          <pattern id="grid-minor" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="#24262c" strokeWidth="1" />
          </pattern>
          <pattern id="grid-major" width="100" height="100" patternUnits="userSpaceOnUse">
            <path d="M100 0H0V100" fill="none" stroke="#2c2f37" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="640" height="400" fill="#17181c" />
        <rect width="640" height="400" fill="url(#grid-minor)" />
        <rect width="640" height="400" fill="url(#grid-major)" />
        <g stroke="#4d7ac7" strokeWidth="1.4">
          <path d="M110 320h44" />
          <path d="M110 320v-44" />
        </g>
        <text x="158" y="324" fill="#4d7ac7" fontSize="10" fontFamily={mono}>+X</text>
        <text x="98" y="270" fill="#4d7ac7" fontSize="10" fontFamily={mono}>+Y</text>
        <path
          className="outline"
          d="M 110 320 L 110 150 A 60 60 0 0 1 170 90 L 420 90 L 420 240 L 520 240 L 520 320 Z"
          fill="#3574f0"
          fillOpacity="0.07"
          stroke="#c7d0dc"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <g className="fade" style={{ animationDelay: "1.6s" }}>
          <circle cx="300" cy="180" r="42" fill="none" stroke="#c7d0dc" strokeWidth="2" />
          <circle cx="170" cy="150" r="16" fill="none" stroke="#c7d0dc" strokeWidth="2" />
          <circle cx="470" cy="285" r="16" fill="none" stroke="#c7d0dc" strokeWidth="2" />
        </g>
        <g className="fade" style={{ animationDelay: "2.1s" }}>
          <path d="M170 90h250" stroke="#5a8dff" strokeWidth="3" strokeLinecap="round" />
          <rect x="165" y="85" width="10" height="10" fill="#5a8dff" />
          <rect x="415" y="85" width="10" height="10" fill="#5a8dff" />
          <rect x="412" y="232" width="16" height="16" fill="none" stroke="#5ad1c5" strokeWidth="2" />
        </g>
        <g className="fade" style={{ animationDelay: "2.5s" }}>
          <g stroke="#5ad1c5" strokeWidth="1.4">
            <path d="M110 328v40" strokeDasharray="4 4" />
            <path d="M520 328v40" strokeDasharray="4 4" />
            <path d="M110 358h410" />
            <path d="M110 353l8 5-8 5" fill="none" />
            <path d="M520 353l-8 5 8 5" fill="none" />
          </g>
          <rect x="268" y="345" width="104" height="24" rx="5" fill="#17181c" />
          <text x="320" y="361" fill="#5ad1c5" fontSize="12.5" fontFamily={mono} textAnchor="middle">410.00 mm</text>
          <path d="M420 240l14 30-6 1 5 12-5 2-5-12-5 4z" fill="#e8e9ec" stroke="#17181c" strokeWidth="1.2" strokeLinejoin="round" />
        </g>
      </svg>
    </div>
  );
}
