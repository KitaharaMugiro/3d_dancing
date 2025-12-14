import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';

// Configuration
const PARALLAX_SCALE = 50.0;
const MODEL_PATH = 'HoushouMarine/宝鐘マリンV2.pmx';

// "Virtual Screen" dimensions
// SCREEN_WIDTH is fixed world units.
// SCREEN_HEIGHT will be calculated based on window aspect ratio.
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
let headZ = 30; // Closer for stronger parallax (User Suggestion: 30)

async function init() {
    setupThreeJS();
    createEnvironment();
    await loadModel();
    await setupTracking();
    animate();
}

function setupThreeJS() {
    const container = document.getElementById('canvas-container');

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

    // Initial check for size
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
    const w = 80, h = 60, d = 120; // Deeper room (d=120) for background separation
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
    // Standard Plane faces +Z. Back wall needs to face room (towards +Z). 
    // Already facing correct way if room is in front of it? 
    // If z=-120, we look at it from 0. The front face (normal +Z) is towards us. Correct.
    back.receiveShadow = true;
    room.add(back);

    // Left wall
    const left = new THREE.Mesh(new THREE.PlaneGeometry(d, h), mat);
    // Center of wall in Z
    left.position.set(-w / 2, 0, (zFront + zBack) / 2);
    left.rotation.y = Math.PI / 2; // Face right
    left.receiveShadow = true;
    room.add(left);

    // Right wall
    const right = new THREE.Mesh(new THREE.PlaneGeometry(d, h), mat);
    right.position.set(w / 2, 0, (zFront + zBack) / 2);
    right.rotation.y = -Math.PI / 2; // Face left
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

    // Shadow Floor (Invisible physics floor for shadows if needed further)
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
                // Feet on floor. Floor is at -30 (h=60, center=0 -> floor=-30)
                modelMesh.position.y = -30;

                // Depth: Move to z=-5 as requested (center depth).
                // Center Z is 0 in local.
                // We want model center at Z=-5? Or feet?
                // Just setting position.z = -5 - center.z (to offset intrinsic origin)
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
    // FIX 1: Removed requestAnimationFrame recursion
    if (!faceLandmarker || !video || video.paused || video.ended) return;

    const startTimeMs = performance.now();
    if (lastVideoTime === video.currentTime) return;
    lastVideoTime = video.currentTime;

    const results = faceLandmarker.detectForVideo(video, startTimeMs);

    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        const nose = results.faceLandmarks[0][1];

        // FIX: Simple variable extraction
        const rawX = (0.5 - nose.x) * 2;
        const rawY = (nose.y - 0.5) * 2;

        const targetX = rawX * PARALLAX_SCALE;
        const targetY = -rawY * PARALLAX_SCALE * 0.5;

        headX += (targetX - headX) * 0.15;
        headY += (targetY - headY) * 0.15;
    }
    // No recursive call here!
}


function updateOffAxisCamera() {
    camera.position.set(headX, headY, headZ);
    camera.quaternion.identity();

    // FIX 3: Dynamic Frustum based on current SCREEN_HEIGHT
    const near = 0.1;
    const far = 1000.0;

    const dist = Math.abs(camera.position.z);
    const scale = near / dist;

    const left = (-SCREEN_WIDTH / 2 - camera.position.x) * scale;
    const right = (SCREEN_WIDTH / 2 - camera.position.x) * scale;
    const top = (SCREEN_HEIGHT / 2 - camera.position.y) * scale;
    const bottom = (-SCREEN_HEIGHT / 2 - camera.position.y) * scale;

    camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
}

function animate() {
    const time = clock.getElapsedTime();
    if (modelMesh) {
        modelMesh.rotation.y = Math.sin(time * 0.5) * 0.05;
    }
    updateOffAxisCamera();
    renderer.render(scene, camera);
    predictWebcam(); // Called once per frame
    requestAnimationFrame(animate); // Only one rAF loop
}

function onWindowResize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    // FIX 3: Update SCREEN_HEIGHT to match window aspect
    SCREEN_HEIGHT = SCREEN_WIDTH / (window.innerWidth / window.innerHeight);
}

init();
