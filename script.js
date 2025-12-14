import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';

// Configuration
const MODEL_PATH = 'HoushouMarine/宝鐘マリンV2.pmx';

// "Virtual Screen" dimensions
let SCREEN_WIDTH = 40;
let SCREEN_HEIGHT = 22.5;

let scene, camera, renderer;
let modelMesh;
let faceLandmarker;
let video;
let lastVideoTime = -1;
let clock = new THREE.Clock();

// Head position in World Units
let headX = 0;
let headY = 0;
let headZ = 30;

async function init() {
    setupThreeJS();
    createEnvironment();
    await loadModel();
    await setupTracking();
    animate();
}

function setupThreeJS() {
    const container = document.getElementById('canvas-container');

    // Initial camera setup (will be overridden)
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 0, headZ);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    onWindowResize();

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(10, 30, 30);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    scene.add(dirLight);

    // Rim light
    const spotLight = new THREE.SpotLight(0x00ffff, 4.0);
    spotLight.position.set(-30, 20, 0);
    spotLight.lookAt(0, 0, -20);
    scene.add(spotLight);

    window.addEventListener('resize', onWindowResize, false);
}

function createEnvironment() {
    // 1. Grid Texture
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    context.fillStyle = '#111';
    context.fillRect(0, 0, 512, 512);
    context.strokeStyle = '#00ff00';
    context.lineWidth = 4;
    context.beginPath();
    for (let i = 0; i <= 512; i += 64) {
        context.moveTo(i, 0); context.lineTo(i, 512);
        context.moveTo(0, i); context.lineTo(512, i);
    }
    context.stroke();

    const gridTexture = new THREE.CanvasTexture(canvas);
    gridTexture.wrapS = THREE.RepeatWrapping;
    gridTexture.wrapT = THREE.RepeatWrapping;
    gridTexture.repeat.set(2, 2);

    // 2. Open Room (5 Planes)
    const w = 80, h = 60, d = 120;
    const zFront = 0, zBack = -120;

    const mat = new THREE.MeshStandardMaterial({
        map: gridTexture,
        transparent: true,
        opacity: 0.3,
        roughness: 0.8,
        side: THREE.DoubleSide
    });

    const room = new THREE.Group();

    // Back wall
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    back.position.set(0, 0, zBack);
    back.receiveShadow = true;
    room.add(back);

    // Left wall
    const left = new THREE.Mesh(new THREE.PlaneGeometry(d, h), mat);
    left.position.set(-w / 2, 0, (zFront + zBack) / 2);
    left.rotation.y = Math.PI / 2;
    left.receiveShadow = true;
    room.add(left);

    // Right wall
    const right = new THREE.Mesh(new THREE.PlaneGeometry(d, h), mat);
    right.position.set(w / 2, 0, (zFront + zBack) / 2);
    right.rotation.y = -Math.PI / 2;
    right.receiveShadow = true;
    room.add(right);

    // Ceiling
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    ceil.position.set(0, h / 2, (zFront + zBack) / 2);
    ceil.rotation.x = Math.PI / 2;
    ceil.receiveShadow = true;
    room.add(ceil);

    // Floor
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    floor.position.set(0, -h / 2, (zFront + zBack) / 2);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    room.add(floor);

    scene.add(room);

    // Explicit Grid Helper on floor
    const gridHelper = new THREE.GridHelper(w, 20, 0x00ff00, 0x003300);
    gridHelper.position.set(0, -h / 2 + 0.1, (zFront + zBack) / 2);
    scene.add(gridHelper);

    // Shadow Floor
    const shadowFloorMat = new THREE.ShadowMaterial({ opacity: 0.5 });
    const shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), shadowFloorMat);
    shadowFloor.rotation.x = -Math.PI / 2;
    shadowFloor.position.set(0, -h / 2 + 0.2, (zFront + zBack) / 2);
    shadowFloor.receiveShadow = true;
    scene.add(shadowFloor);
}

async function loadModel() {
    const loader = new MMDLoader();
    try {
        await new Promise((resolve, reject) => {
            loader.load(MODEL_PATH, (mesh) => {
                modelMesh = mesh;
                modelMesh.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });

                const box = new THREE.Box3().setFromObject(modelMesh);
                const center = box.getCenter(new THREE.Vector3());

                modelMesh.position.x = -center.x;
                modelMesh.position.y = -30;
                modelMesh.position.z = -5 - center.z;

                scene.add(modelMesh);
                resolve();
            }, undefined, reject);
        });
    } catch (error) {
        console.error("MMD Load Error", error);
    }
}

async function setupTracking() {
    video = document.getElementById('webcam');
    const filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
            delegate: "GPU"
        },
        outputFaceBlendshapes: false,
        runningMode: "VIDEO",
        numFaces: 1
    });

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        video.addEventListener("loadeddata", () => {
            document.getElementById('loading').style.display = 'none';
        });
    } catch (err) {
        console.error("Webcam error:", err);
    }
}

function predictWebcam() {
    if (!faceLandmarker || !video || video.paused || video.ended) return;

    const startTimeMs = performance.now();
    if (lastVideoTime === video.currentTime) return;
    lastVideoTime = video.currentTime;

    const results = faceLandmarker.detectForVideo(video, startTimeMs);

    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        // FIX 3: Use Eye Midpoint instead of Nose to reduce rotation noise
        const lm = results.faceLandmarks[0];
        const leftEye = lm[33];
        const rightEye = lm[263];

        const midX = (leftEye.x + rightEye.x) * 0.5;
        const midY = (leftEye.y + rightEye.y) * 0.5;

        // Inverted X for mirror effect
        const rawX = (0.5 - midX) * 2;
        const rawY = (midY - 0.5) * 2;

        // FIX 2: Scale based on Window logic (1.2 multiplier for comfort)
        const targetX = rawX * (SCREEN_WIDTH * 0.5) * 1.2;
        const targetY = -rawY * (SCREEN_HEIGHT * 0.5) * 1.2;

        headX += (targetX - headX) * 0.15;
        headY += (targetY - headY) * 0.15;

        // FIX 2: Clamp to screen bounds to prevent breaking the illusion
        headX = THREE.MathUtils.clamp(headX, -SCREEN_WIDTH * 0.45, SCREEN_WIDTH * 0.45);
        headY = THREE.MathUtils.clamp(headY, -SCREEN_HEIGHT * 0.45, SCREEN_HEIGHT * 0.45);
    }
}

function updateOffAxisCamera() {
    camera.position.set(headX, headY, headZ);
    camera.quaternion.identity();

    // FIX 1: Update near/far and projectionMatrixInverse
    const near = 0.1;
    const far = 1000.0;
    camera.near = near;
    camera.far = far;

    const dist = Math.abs(camera.position.z);
    const scale = near / dist;

    const left = (-SCREEN_WIDTH / 2 - camera.position.x) * scale;
    const right = (SCREEN_WIDTH / 2 - camera.position.x) * scale;
    const top = (SCREEN_HEIGHT / 2 - camera.position.y) * scale;
    const bottom = (-SCREEN_HEIGHT / 2 - camera.position.y) * scale;

    camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far);

    // CRITICAL: Update inverse matrix to avoid side-effects
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

function animate() {
    const time = clock.getElapsedTime();
    if (modelMesh) {
        // Continuous rotation
        modelMesh.rotation.y = time * 0.5;
    }
    updateOffAxisCamera();
    renderer.render(scene, camera);
    predictWebcam();
    requestAnimationFrame(animate);
}

function onWindowResize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Dynamic height to match aspect ratio
    SCREEN_HEIGHT = SCREEN_WIDTH / (window.innerWidth / window.innerHeight);
}

init();
