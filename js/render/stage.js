// 描画の土台: シーン・カメラ・ライト・霧・発光(ブルーム)。
(function (TL) {
  'use strict';

  class Stage3D {
    constructor(container) {
      const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      // 明るい青が白に寄らないよう、トーンマッピングは使わず色をそのまま出す
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputEncoding = THREE.sRGBEncoding;
      container.appendChild(renderer.domElement);
      this.renderer = renderer;
      this.dom = renderer.domElement;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x020309);
      scene.fog = new THREE.FogExp2(0x020309, 0.026);
      this.scene = scene;

      this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 400);

      scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x1a0d22, 0.5));
      // カメラについていく灯り(泳いでいる生物を照らす)
      this.headlamp = new THREE.PointLight(0xcfe3ff, 1.4, 40, 1.6);
      this.camera.add(this.headlamp);
      scene.add(this.camera);

      // 発光: 明るい所だけをにじませる(読み込めない環境では素の描画)
      if (THREE.EffectComposer && THREE.UnrealBloomPass) {
        const composer = new THREE.EffectComposer(renderer);
        composer.addPass(new THREE.RenderPass(scene, this.camera));
        this.bloom = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.45, 0.32);
        composer.addPass(this.bloom);
        this.composer = composer;
      }

      window.addEventListener('resize', () => this.resize());
    }

    resize() {
      const w = window.innerWidth, h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      if (this.composer) this.composer.setSize(w, h);
    }

    render() {
      if (this.composer) this.composer.render();
      else this.renderer.render(this.scene, this.camera);
    }
  }

  TL.Stage3D = Stage3D;
})(window.TL = window.TL || {});
