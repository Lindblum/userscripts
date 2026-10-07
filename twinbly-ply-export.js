// ==UserScript==
// @author       Lindblum
// @name         Twinbly PLY Export
// @namespace    https://www.twinbly.com/
// @version      1.3
// @description  Exports a Twinbly gaussian-splat scene's points (position + base color) as an ASCII .ply point cloud, cropped to a radius
// @match        https://www.twinbly.com/v/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @copyright    2026, Lindblum
// ==/UserScript==

/*
Turn Twinbly's visualizer to VR, or extract a model to print for Rispoli
https://www.twinbly.com/v/larrydalton/kraft-boulders-the-cube
/api/splats/public/1kr07pr2/sogs/[i]_[j]/
	meta.json			Dimensions, splat count, quantization parameters, bounds
	means_l.webp		328x328	variable	Lower/significant bits of XYZ positions
	means_u.webp		328x328	variable	Upper bits of XYZ positions
	quats.webp			328x328	variable	Quaternion rotations
	scales.webp			328x328	variable	Gaussian scale vectors
	sh0.webp			524x520	variable	Zeroth spherical harmonic (base color)
	shN_centroids.webp	512x1024variable	Compressed higher-order SH coefficients
	shN_labels.webp		328x328	variable	Cluster indices into the centroid table
The center is the mean of the Gaussian, and the scales plus quaternion define its principal axes.
Other notes:
    settings.sceneScale.metersPerUnit
    settings.clip.radius
    settings.plyUrl
    settings.gps.lat, lng
*/

(function () {
	'use strict';

	async function loadImageData(url) {
	    const img = new Image();
	    img.crossOrigin = "anonymous";
	    img.src = url;
	    await img.decode();
	    const canvas = document.createElement("canvas");
	    canvas.width = img.width;
	    canvas.height = img.height;
	    const ctx = canvas.getContext("2d");
	    ctx.drawImage(img, 0, 0);
	    return ctx.getImageData(0, 0, img.width, img.height).data;
	} //loadImageData

	function decodeCenters(meansLData, meansUData, meta) {
	    const out = [];
	    const mins = meta.means.mins;
	    const maxs = meta.means.maxs;
	    const lerp = (a, b, t) => a + (b - a) * t;
	    for (let i = 0; i < meansLData.length; i += 4) {
	        const decodeAxis = (c) => {
	            const q = (meansUData[i + c] << 8) | meansLData[i + c];
	            const n = q / 65535;
	            const v = lerp(mins[c], maxs[c], n);
	            return Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
	        };
	        out.push({x: decodeAxis(0), y: decodeAxis(1), z: decodeAxis(2)});
	    }
	    return out;
	} //decodeCenters

	//TODO: Fix
	function computeNormals(quats, scales) {
	    const normals = [];
	    for (let i = 0; i < quats.length; i++) {
	        const s = scales[i];
	        let axis = [1, 0, 0];
	        if (s.y <= s.x && s.y <= s.z)
	            axis = [0, 1, 0];
	        if (s.z <= s.x && s.z <= s.y)
	            axis = [0, 0, 1];
	        let normVals = rotateQuaternion(quats[i], axis);
			let norm = {x:normVals[0], y:normVals[1], z:normVals[2]};
	        normals.push( norm ); //normNums
	    }
	    return normals;
	} //computeNormals

	function decodeScales(scaleData, meta) {
	    const scales = [];
	    for (let i = 0; i < scaleData.length; i += 4) {
	        scales.push({
	            x: decodeScale(scaleData[i+0], 0, meta),
	            y: decodeScale(scaleData[i+1], 1, meta),
	            z: decodeScale(scaleData[i+2], 2, meta)
	        });
	    }
	    return scales;
	} //decodeScales

	function decodeScale(v, axis, meta) {
		/*
		const t = v / 255;
		const s = meta.means.mins[axis] + t * ( meta.means.maxs[axis] - meta.means.mins[axis]);
		const s = meta.scales.mins[axis] + t * (meta.scales.maxs[axis] - meta.scales.mins[axis]);
		return Math.exp(s);
		//*/
		return meta.scales.codebook[v];
	//	return meta.scales.codebook[v][axis];
	} //decodeScale

	//TODO: Fix
	function computeFoci(centers, quats, scales) {
	    const points = [];
	    for (let i = 0; i < centers.length; i++) {
	        const center = centers[i];
	        const quat = quats[i];
	        const scale = scales[i];
	        const s = [scale.x, scale.y, scale.z];
	        const major = Math.max(...s);
	        const minor = Math.min(...s);
	        let axis = [1,0,0];
	        if (major === scale.y) axis = [0,1,0];
	        else if (major === scale.z) axis = [0,0,1];
	        const dir = rotateQuaternion(quat, axis);
	        const c = Math.sqrt(Math.max(0, major*major - minor*minor));	//Is this too large?
	        points.push({
	            x: center.x + c * dir[0],
	            y: center.y + c * dir[1],
	            z: center.z + c * dir[2]
	        });
	        points.push({
	            x: center.x - c * dir[0],
	            y: center.y - c * dir[1],
	            z: center.z - c * dir[2]
	        });
	    }
	    return points;
	} //computeFoci

	function decodeSh0(sh0Data) {
	    const colors = [];
	    for (let i = 0; i < sh0Data.length; i += 4) {
	        colors.push({
	            r: sh0Data[i],
	            g: sh0Data[i+1],
	            b: sh0Data[i+2]
	        });
	    }
	    return colors;
	} //decodeSh0

	function decodeQuats(quatsData) {
	    const quats = [];
	    for (let i = 0; i < quatsData.length; i += 4) {
			//Bytes to floats
	        let x = quatsData[i]     / 127.5 - 1.0;
	        let y = quatsData[i + 1] / 127.5 - 1.0;
	        let z = quatsData[i + 2] / 127.5 - 1.0;
	        let w = quatsData[i + 3] / 127.5 - 1.0;
	        const len = Math.hypot(x, y, z, w);
	        if (len > 0) {
	            x /= len;
	            y /= len;
	            z /= len;
	            w /= len;
	        }
	        quats.push({ x, y, z, w });
	    }
	    return quats;
	} //decodeQuats

	function rotateQuaternion(q, v) {
	    const { x, y, z, w } = q;
	    // t = 2 * cross(q.xyz, v)
	    const tx = 2 * (y * v[2] - z * v[1]);
	    const ty = 2 * (z * v[0] - x * v[2]);
	    const tz = 2 * (x * v[1] - y * v[0]);
	    // v' = v + w*t + cross(q.xyz, t)
	    return [
	        v[0] + w * tx + (y * tz - z * ty),
	        v[1] + w * ty + (z * tx - x * tz),
	        v[2] + w * tz + (x * ty - y * tx)
	    ];
	} //rotateQuaternion

	async function getAllVerts(sceneId, radius, onProgress = () => {}) {
		let allVerts = [];
		const lodMeta = await fetch(`/api/splats/public/${sceneId}/sogs/lod-meta.json`).then(r => r.json());
		let chunkIds = lodMeta.filenames.map(s => s.split('/')[0]);	//['0_0'];// 
		//Filter to chunks that pertain to the radius
		let total = chunkIds.length;
		for ( let c = chunkIds.length-1; c >= 0; c-- ) {
			let chunkId = chunkIds[c];
			onProgress( `Checking chunks ${total-c}/${total}`, (total-c) / total * 0.1 );
			let meta = await fetch(`/api/splats/public/${sceneId}/sogs/${chunkId}/meta.json`).then(r => r.json());
			let xMin = meta.means.mins[0];
			let xMax = meta.means.maxs[0];
			let yMin = meta.means.mins[1];
			let yMax = meta.means.maxs[1];
			let zMin = meta.means.mins[2];
			let zMax = meta.means.maxs[2];
			if ( xMax < -radius || xMin > radius || yMax < -radius || yMin > radius || zMax < -radius || zMin > radius )
				chunkIds.splice(c,1);
		}
		//For each chunk
		for ( let c = 0; c < chunkIds.length; c++ ) {
			let chunkId = chunkIds[c];
		//	console.log( `chunk ${c}/${chunkIds.length} (${chunkId})` );
			//Progress: 6 files per chunk, chunks span 10%-90% of the bar
			let step = 0;
			const tick = () => onProgress( `Loading chunk ${c+1}/${chunkIds.length}`, 0.1 + 0.8 * (c + step++ / 6) / chunkIds.length );
			//Files: meta.json, means_l.webp, means_u.webp, quats.webp, scales.webp, sh0.webp, shN_centroids.webp, shN_labels.webp
			tick(); let meta   = await fetch(`/api/splats/public/${sceneId}/sogs/${chunkId}/meta.json`).then(r => r.json());
			tick(); let sh0Data    = await loadImageData(`/api/splats/public/${sceneId}/sogs/${chunkId}/sh0.webp`);
			tick(); let quatsData  = await loadImageData(`/api/splats/public/${sceneId}/sogs/${chunkId}/quats.webp`);
			tick(); let scaleData  = await loadImageData(`/api/splats/public/${sceneId}/sogs/${chunkId}/scales.webp`);
			tick(); let meansLData = await loadImageData(`/api/splats/public/${sceneId}/sogs/${chunkId}/means_l.webp`);
			tick(); let meansUData = await loadImageData(`/api/splats/public/${sceneId}/sogs/${chunkId}/means_u.webp`);
			let centers = decodeCenters(meansLData, meansUData, meta);
			let colors  = decodeSh0(sh0Data);
		/*
			let quats   = decodeQuats(quatsData, meta);
			let scales  = decodeScales(scaleData, meta);
			let norms   = computeNormals(quats, scales);
		//*/
		//*
			for ( let i = 0; i < centers.length; i++ ) {
				let vert  = centers[i];
				let color = colors[i];
		//*/
		/*
			let foci    = computeFoci(centers, quats, scales);	//Buggy
			for ( let i = 0; i < foci.length; i++ ) {
				let vert  = foci[i];
				let norm  = norms [Math.floor(i/2)];
				let color = colors[Math.floor(i/2)];
		//*/
			//	let norm  = norms[i];
			//	vert.nx = norm.x; vert.ny = norm.y; vert.nz = norm.z;
				vert.r = color.r; vert.g = color.g; vert.b = color.b;
				let inRadius = !radius ? true : (vert.x * vert.x + vert.y * vert.y + vert.z * vert.z <= radius * radius);
				if ( inRadius )
					allVerts.push( vert );
			}
		}
		return allVerts;
	} //getAllVerts

	async function exportPly(verts, filename, onProgress = () => {}) {
		//Headers
		let lines = [];
		lines.push(`ply\n`);
		lines.push(`format ascii 1.0\n`);
		lines.push(`element vertex ${verts.length}\n`);
		lines.push(`property float x\n`);
		lines.push(`property float y\n`);
		lines.push(`property float z\n`);
	/*
		lines.push(`property float nx\n`);
		lines.push(`property float ny\n`);
		lines.push(`property float nz\n`);
	//*/
		lines.push(`property uchar red\n`);
		lines.push(`property uchar green\n`);
		lines.push(`property uchar blue\n`);
		lines.push(`end_header\n`);
		//For each point
		for ( let i = 0; i < verts.length; i++ ) {
			if ( i%100000==0 ) {
				onProgress( `Writing ${i.toLocaleString()}/${verts.length.toLocaleString()} points`, 0.9 + 0.1 * i / verts.length );
				await new Promise(r => setTimeout(r));	//Let the progress bar repaint
			}
			let vert = verts[i];
		//	lines.push(`${vert.x} ${vert.y} ${vert.z} ${vert.nx} ${vert.ny} ${vert.nz} ${vert.r} ${vert.g} ${vert.b}\n`);
			lines.push(`${vert.x} ${vert.y} ${vert.z} ${vert.r} ${vert.g} ${vert.b}\n`);
		}
	//	console.log( `Vertices: ${verts.length}` );
		//Save File
		const blob = new Blob(lines, { type: "text/plain" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = filename;
		a.click();
	//	console.log( `Downloading ${filename}` );
	} //exportPly

	async function exportScene() {
		//Metadata
		let title   = document.querySelector('meta[name="twitter:title"]').content;
		let imgUrl  = document.querySelector('meta[property="og:image"]').content;
		let sceneId = new URL(imgUrl).pathname.split('/').pop();
		let settings = await fetch(`/api/splats/public/${sceneId}/settings`).then(r => r.json());
		let toMeters = settings.settings.sceneScale.metersPerUnit;
		let docName = window.location.pathname.split('/').pop();

		//Radius (scene units; blank or 0 = everything)
		let progress = showPanel();
		let radius = await progress.askRadius(toMeters, 2);
		if ( radius === null ) {
			progress.close();
			return;
		}

		//Export
		try {
			let allVerts = await getAllVerts( sceneId, radius, progress.update );
			let plyName = radius ? `${docName}[r=${radius}].ply` : `${docName}.ply`;
			await exportPly(allVerts, plyName, progress.update);
			progress.update( `Downloaded ${allVerts.length.toLocaleString()} points`, 1 );
			await new Promise(r => setTimeout(r, 1500));
		} finally {
			progress.close();
		}
	} //exportScene

	//Export pill (radius form, then progress bar), styled like the viewer's menu bar and placed just below it
	const PROGRESS_ID = 'tm-ply-progress';
	function showPanel() {
		document.getElementById(PROGRESS_ID)?.remove();
		let bar = document.querySelector(BAR_SELECTOR);
		let panel = document.createElement('div');
		panel.id = PROGRESS_ID;
		panel.className = bar ? bar.className : '';
		Object.assign(panel.style, {
			position: 'fixed', top: 'auto', bottom: 'auto', right: 'auto', transform: 'none', margin: '0', zIndex: 2147483647, display: 'flex', alignItems: 'center', gap: '10px',
			padding: '6px 6px 6px 14px', width: '300px', minHeight: '40px', boxSizing: 'border-box',
			color: 'rgba(255,255,255,0.9)', font: '500 12px/1.4 system-ui, sans-serif',
			opacity: '0', transition: 'opacity 300ms ease-out'
		});
		if ( !bar ) {
			//Fallback if the menu bar isn't found: same look, inline
			Object.assign(panel.style, {
				background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(12px)', webkitBackdropFilter: 'blur(12px)',
				border: '1px solid rgba(255,255,255,0.15)', borderRadius: '9999px'
			});
		}
		const pillBtn = 'border:0;border-radius:9999px;padding:5px 12px;font:inherit;cursor:pointer;color:inherit;transition:background 150ms ease-out';
		panel.innerHTML = `
			<form data-form style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;margin:0">
				<label for="tm-ply-radius" style="white-space:nowrap">Radius</label>
				<input id="tm-ply-radius" data-radius type="number" min="0" step="any" placeholder="all"
					style="width:56px;min-width:0;padding:4px 8px;border-radius:9999px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:inherit;font:inherit;outline:none">
				<span data-meters style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(255,255,255,0.55)"></span>
				<button type="submit" data-hover style="${pillBtn};background:rgba(255,255,255,0.15)">Export</button>
				<button type="button" data-cancel data-hover title="Cancel" aria-label="Cancel" style="${pillBtn};padding:5px 8px;background:transparent">✕</button>
			</form>
			<div data-progress style="display:none;flex:1;min-width:0;align-items:center;gap:10px;padding-right:8px">
			<div style="flex:1;min-width:0">
				<div data-label style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Starting…</div>
				<div style="margin-top:4px;height:4px;border-radius:9999px;background:rgba(255,255,255,0.15);overflow:hidden">
					<div data-fill style="height:100%;width:0;border-radius:9999px;background:rgba(255,255,255,0.85);transition:width 200ms ease-out"></div>
				</div>
			</div>
			<div data-pct style="font-variant-numeric:tabular-nums;min-width:3ch;text-align:right">0%</div>
			</div>`;
		panel.querySelectorAll('[data-hover]').forEach(b => {
			let base = b.style.background;
			b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,0.25)');
			b.addEventListener('mouseleave', () => b.style.background = base);
		});
		//Keep typing from reaching the viewer's keyboard controls
		for ( let type of ['keydown', 'keyup', 'keypress'] )
			panel.addEventListener(type, e => e.stopPropagation());
		//Position under the bar (or above it if the bar sits at the bottom of the screen)
		let r = bar ? bar.getBoundingClientRect() : { left: window.innerWidth / 2, width: 0, top: 16, bottom: 16 };
		panel.style.left = `${Math.max(8, r.left + r.width / 2 - 150)}px`;
		if ( r.top > window.innerHeight / 2 )
			panel.style.bottom = `${window.innerHeight - r.top + 8}px`;
		else
			panel.style.top = `${r.bottom + 8}px`;
		document.body.appendChild(panel);
		requestAnimationFrame(() => panel.style.opacity = '1');

		let form     = panel.querySelector('[data-form]');
		let input    = panel.querySelector('[data-radius]');
		let meters   = panel.querySelector('[data-meters]');
		let progress = panel.querySelector('[data-progress]');
		let label    = panel.querySelector('[data-label]');
		let fill     = panel.querySelector('[data-fill]');
		let pct      = panel.querySelector('[data-pct]');
		return {
			//Resolves to the radius in scene units (0 = whole scene), or null if cancelled
			askRadius(toMeters, defaultRadius) {
				const hint = () => {
					let v = parseFloat(input.value);
					meters.textContent = v > 0 ? `≈ ${+(v * toMeters).toFixed(1)} m` : 'whole scene';
				};
				input.value = defaultRadius;
				hint();
				input.addEventListener('input', hint);
				requestAnimationFrame(() => { input.focus(); input.select(); });
				return new Promise(resolve => {
					const done = (value) => {
						form.style.display = 'none';
						progress.style.display = 'flex';
						resolve(value);
					};
					form.addEventListener('submit', e => { e.preventDefault(); done(parseFloat(input.value) || 0); });
					panel.querySelector('[data-cancel]').addEventListener('click', () => done(null));
					input.addEventListener('keydown', e => { if ( e.key === 'Escape' ) done(null); });
				});
			},
			update(text, fraction) {
				let p = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
				label.textContent = text;
				fill.style.width = `${p}%`;
				pct.textContent = `${p}%`;
			},
			close() {
				panel.style.opacity = '0';
				setTimeout(() => panel.remove(), 300);
			}
		};
	} //showPanel

	//Menu bar button
	const BUTTON_ID = 'tm-ply-export';
	const BAR_SELECTOR = '[class*="backdrop-blur-md"][class*="rounded-full"][class*="flex-row"]';
	const ICON_DOWNLOAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

	function addButton() {
		if ( document.getElementById(BUTTON_ID) )
			return;
		let bar = document.querySelector(BAR_SELECTOR);
		if ( !bar )
			return;
		//Borrow the look of an existing button in the bar
		let sample = bar.querySelector('button');
		let sampleSvg = sample && sample.querySelector('svg');
		let btn = document.createElement('button');
		btn.id = BUTTON_ID;
		btn.type = 'button';
		btn.title = 'Download PLY';
		btn.setAttribute('aria-label', 'Download PLY');
		btn.className = sample ? sample.className : 'p-2 text-white/80 hover:text-white transition-colors';
		btn.innerHTML = ICON_DOWNLOAD;
		let svg = btn.querySelector('svg');
		if ( sampleSvg ) {
			svg.setAttribute('class', sampleSvg.getAttribute('class') || '');
			svg.setAttribute('width', sampleSvg.getAttribute('width') || '20');
			svg.setAttribute('height', sampleSvg.getAttribute('height') || '20');
		} else {
			svg.setAttribute('width', '20');
			svg.setAttribute('height', '20');
		}
		btn.addEventListener('click', async (e) => {
			e.preventDefault();
			e.stopPropagation();
			if ( btn.disabled )
				return;
			btn.disabled = true;
			btn.style.opacity = '0.5';
			btn.style.cursor = 'progress';
			try {
				await exportScene();
			} catch (err) {
				console.error(err);
				alert(`PLY export failed: ${err.message}`);
			} finally {
				btn.disabled = false;
				btn.style.opacity = '';
				btn.style.cursor = '';
			}
		});
		bar.appendChild(btn);
	} //addButton

	//The viewer renders client-side, so wait for the bar (and re-add if it gets re-rendered)
	addButton();
	new MutationObserver(addButton).observe(document.body, { childList: true, subtree: true });

	GM_registerMenuCommand('Export PLY', exportScene);
})();
