import { useEffect, useRef } from "react";

/**
 * HalftoneFlow — animated WebGL halftone-dot fluid backdrop.
 *
 * Pure <canvas> port of the "nexus unified flow" shader: rotating domain-warped
 * flow field quantized into a halftone dot grid. Runs fully offline (no CDN,
 * no iframe), pauses when the tab is hidden, and renders a static frame when
 * the user prefers reduced motion.
 *
 * Props:
 *   className — styling/positioning from the parent (default: fixed backdrop)
 *   intensity — dot grid size multiplier (higher = coarser dots). 6 ≈ template.
 */
export default function HalftoneFlow({ className = "", intensity = 6, style }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
    if (!gl) return undefined; // CSS aurora backdrop stays visible as fallback

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // --- Shaders (adapted from the halftone-flow template, aurora palette) --
    const vsSource = `
      attribute vec4 aVertexPosition;
      void main() {
        gl_Position = aVertexPosition;
      }
    `;
    const fsSource = `
      precision mediump float;
      uniform vec2 u_resolution;
      uniform float u_time;
      uniform float u_grid;

      mat2 rot(float a) {
        float s = sin(a), c = cos(a);
        return mat2(c, -s, s, c);
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution.xy;
        vec2 p = uv * 2.0 - 1.0;
        p.x *= u_resolution.x / u_resolution.y;

        vec2 flow_uv = p;
        float time = u_time * 0.4;

        for (float i = 1.0; i < 4.0; i++) {
          flow_uv *= rot(time * 0.1);
          flow_uv.x += sin(flow_uv.y * 2.0 * i + time) * 0.5;
          flow_uv.y += cos(flow_uv.x * 1.5 * i - time * 0.8) * 0.5;
        }

        float intensity = sin(flow_uv.x * 2.0 + flow_uv.y * 3.0) * 0.5 + 0.5;

        // Aurora palette: deep void → violet → cyan-magenta glow
        vec3 col_dark = vec3(0.02, 0.023, 0.06);
        vec3 col_mid = vec3(0.545, 0.357, 0.965); // #8b5cf6
        vec3 col_bright = vec3(0.133, 0.827, 0.933); // #22d3ee

        vec3 fluid_color = mix(col_dark, col_mid, smoothstep(0.2, 0.6, intensity));
        fluid_color = mix(fluid_color, col_bright, smoothstep(0.7, 1.0, intensity));

        float gridSize = u_grid;
        vec2 grid_uv = gl_FragCoord.xy / gridSize;
        vec2 cell_uv = fract(grid_uv) - 0.5;
        float dist = length(cell_uv);
        float radius = intensity * 0.45;
        float dot_mask = smoothstep(radius, radius - 0.1, dist);

        vec3 final_color = mix(vec3(0.0), fluid_color, dot_mask);
        final_color += fluid_color * 0.15;

        gl_FragColor = vec4(final_color, 1.0);
      }
    `;

    function compile(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("HalftoneFlow shader:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return undefined;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return undefined;
    gl.useProgram(program);

    // Fullscreen quad
    const positions = new Float32Array([-1, 1, 1, 1, -1, -1, 1, -1]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "aVertexPosition");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, "u_resolution");
    const uTime = gl.getUniformLocation(program, "u_time");
    const uGrid = gl.getUniformLocation(program, "u_grid");
    gl.uniform1f(uGrid, intensity);

    // Size the drawing buffer to the element (capped for perf on 4K screens)
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = (t) => {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    let raf = 0;
    const start = performance.now();
    if (prefersReduced) {
      // Static single frame — still gives the halftone texture, no motion.
      draw(4.0);
    } else {
      let visible = true;
      const onVisibility = () => {
        visible = document.visibilityState === "visible";
        if (visible && !raf) raf = requestAnimationFrame(loop);
      };
      const loop = () => {
        if (!visible) {
          raf = 0;
          return;
        }
        draw((performance.now() - start) / 1000);
        raf = requestAnimationFrame(loop);
      };
      document.addEventListener("visibilitychange", onVisibility);
      raf = requestAnimationFrame(loop);

      return () => {
        cancelAnimationFrame(raf);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("resize", resize);
        gl.deleteProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.deleteBuffer(buffer);
      };
    }

    return () => {
      window.removeEventListener("resize", resize);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buffer);
    };
  }, [intensity]);

  return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" />;
}
