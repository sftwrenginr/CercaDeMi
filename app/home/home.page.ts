import { AfterViewInit, Component, NgZone, OnDestroy } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Geolocation, Position } from '@capacitor/geolocation';
import { Share } from '@capacitor/share';
import * as L from 'leaflet';

type Category = 'Todos' | 'Restaurantes' | 'Tiendas' | 'Turismo';
interface Place { id: string; name: string; category: Exclude<Category, 'Todos'>; lat: number; lon: number; distance: number; }
interface OsmElement { type: 'node' | 'way' | 'relation'; id: number; lat?: number; lon?: number; center?: {lat: number; lon: number}; tags?: Record<string, string>; }

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OVERPASS = 'https://overpass-api.de/api/interpreter';

@Component({ selector: 'app-home', templateUrl: 'home.page.html', styleUrls: ['home.page.scss'], standalone: false })
export class HomePage implements AfterViewInit, OnDestroy {
  category: Category = 'Todos';
  readonly categories: Category[] = ['Todos', 'Restaurantes', 'Tiendas', 'Turismo'];
  query = '';
  status = 'Pulsa «Mi ubicación» para comenzar.';
  error = '';
  loading = false;
  location?: Position;
  places: Place[] = [];
  selected?: Place;
  private map?: L.Map;
  private userMarker?: L.CircleMarker;
  private accuracyCircle?: L.Circle;
  private markers = L.layerGroup();
  private watchId?: string;
  private controller?: AbortController;
  private alive = true;
  private requestId = 0;

  constructor(private zone: NgZone) {}

  ngAfterViewInit(): void {
    // El mapa se crea una sola vez, cuando Ionic ha dibujado el contenedor.
    setTimeout(() => {
      if (!this.alive) return;
      this.map = L.map('map', { zoomControl: false }).setView([19.4517, -70.6970], 13);
      L.tileLayer(TILES, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(this.map);
      this.markers.addTo(this.map);
      L.control.zoom({ position: 'bottomright' }).addTo(this.map);
      this.map.invalidateSize();
    }, 100);
  }

  get filteredPlaces(): Place[] {
    const q = this.query.trim().toLocaleLowerCase('es');
    return this.places.filter(p => (this.category === 'Todos' || p.category === this.category) && (!q || p.name.toLocaleLowerCase('es').includes(q)));
  }

  async locate(): Promise<void> {
    this.error = '';
    this.status = 'Buscando señal de ubicación…';
    try {
      if (Capacitor.isNativePlatform()) {
        const permission = await Geolocation.requestPermissions();
        if (permission.location !== 'granted') throw new Error('Permiso de ubicación denegado. Actívalo en los ajustes del dispositivo.');
      }
      const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
      if (!this.alive) return;
      this.updatePosition(position, true);
      await this.startWatch();
      await this.searchNearby();
    } catch (e) {
      if (this.alive) { this.error = this.message(e, 'No fue posible obtener la ubicación. Comprueba GPS y permisos.'); this.status = 'Ubicación no disponible'; }
    }
  }

  private async startWatch(): Promise<void> {
    if (this.watchId) await Geolocation.clearWatch({ id: this.watchId });
    this.watchId = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0, minimumUpdateInterval: 5000 }, (position, error) => {
      this.zone.run(() => {
        if (!this.alive) return;
        if (error) { this.error = 'Se interrumpió el seguimiento. Puedes volver a pulsar Mi ubicación.'; return; }
        if (position) this.updatePosition(position, false);
      });
    });
  }

  private updatePosition(position: Position, center: boolean): void {
    this.location = position;
    const { latitude, longitude, accuracy } = position.coords;
    const point: L.LatLngTuple = [latitude, longitude];
    if (this.map) {
      if (this.userMarker) this.userMarker.setLatLng(point);
      else this.userMarker = L.circleMarker(point, { radius: 9, color: '#ffffff', weight: 3, fillColor: '#1668dc', fillOpacity: 1 }).addTo(this.map).bindPopup('Tu ubicación');
      if (this.accuracyCircle) this.accuracyCircle.setLatLng(point).setRadius(accuracy);
      else this.accuracyCircle = L.circle(point, { radius: accuracy, stroke: false, fillColor: '#1668dc', fillOpacity: 0.12 }).addTo(this.map);
      if (center) this.map.setView(point, 15);
    }
    this.status = `Ubicación actualizada · precisión estimada ±${Math.round(accuracy)} m`;
  }

  async searchNearby(): Promise<void> {
    if (!this.location || this.loading) return;
    this.error = '';
    this.loading = true;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const id = ++this.requestId;
    const { latitude: lat, longitude: lon } = this.location.coords;
    // Solo se consulta al pulsar buscar o tras obtener la primera posición.
    const q = `[out:json][timeout:20];(nwr(around:1500,${lat},${lon})[amenity~"^(restaurant|cafe|fast_food)$"];nwr(around:1500,${lat},${lon})[shop];nwr(around:1500,${lat},${lon})[tourism~"^(attraction|museum|viewpoint)$"];);out center 100;`;
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(OVERPASS, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams({ data: q }), signal: controller.signal });
      if (!response.ok) throw new Error(`El servicio de lugares respondió ${response.status}.`);
      const data: {elements?: OsmElement[]} = await response.json();
      if (!this.alive || id !== this.requestId) return;
      const unique = new Map<string, Place>();
      for (const item of data.elements ?? []) {
        const lat2 = item.lat ?? item.center?.lat, lon2 = item.lon ?? item.center?.lon;
        if (lat2 === undefined || lon2 === undefined || !item.tags?.['name']) continue;
        const category: Place['category'] = item.tags['tourism'] ? 'Turismo' : item.tags['shop'] ? 'Tiendas' : 'Restaurantes';
        const place: Place = { id: `${item.type}/${item.id}`, name: item.tags['name'], category, lat: lat2, lon: lon2, distance: this.distance(lat, lon, lat2, lon2) };
        unique.set(place.id, place);
      }
      this.places = [...unique.values()].sort((a,b) => a.distance - b.distance).slice(0, 60);
      this.drawMarkers();
      this.status = `${this.places.length} lugares encontrados cerca de tu posición`;
    } catch (e) {
      if (this.alive && id === this.requestId) this.error = this.message(e, 'No se pudieron cargar los lugares. Comprueba Internet e inténtalo nuevamente.');
    } finally {
      clearTimeout(timer);
      if (this.alive && id === this.requestId) this.loading = false;
    }
  }

  changeCategory(category: Category): void { this.category = category; this.drawMarkers(); }

  private drawMarkers(): void {
    if (!this.map) return;
    this.markers.clearLayers();
    for (const place of this.filteredPlaces) {
      L.circleMarker([place.lat, place.lon], { radius: 7, color: '#fff', weight: 2, fillColor: place.category === 'Turismo' ? '#e58836' : place.category === 'Tiendas' ? '#7458b5' : '#1a9b79', fillOpacity: 1 })
        .bindTooltip(place.name).on('click', () => this.zone.run(() => this.selected = place)).addTo(this.markers);
    }
  }
  onQueryChange(): void { this.drawMarkers(); }
  showPlace(place: Place): void { this.selected = place; this.map?.setView([place.lat, place.lon], 16); }

  async shareLocation(): Promise<void> {
    if (!this.location) return;
    const {latitude, longitude} = this.location.coords;
    const url = `https://www.openstreetmap.org/?mlat=${latitude.toFixed(6)}&mlon=${longitude.toFixed(6)}#map=17/${latitude.toFixed(6)}/${longitude.toFixed(6)}`;
    try { await Share.share({ title: 'Mi ubicación', text: 'Esta es mi ubicación actual al momento de compartir:', url, dialogTitle: 'Compartir ubicación' }); }
    catch { this.error = 'No se pudo abrir el menú para compartir.'; }
  }

  private distance(a: number,b: number,c: number,d: number): number {
    const r = Math.PI / 180, x = (c-a)*r, y = (d-b)*r;
    const h = Math.sin(x/2)**2 + Math.cos(a*r)*Math.cos(c*r)*Math.sin(y/2)**2;
    return Math.round(12742000*Math.atan2(Math.sqrt(h),Math.sqrt(1-h)));
  }
  private message(error: unknown, fallback: string): string {
    const s = error instanceof Error ? error.message : '';
    return s.startsWith('Permiso') || s.startsWith('El servicio') ? s : fallback;
  }
  ngOnDestroy(): void {
    this.alive = false;
    this.controller?.abort();
    if (this.watchId) void Geolocation.clearWatch({ id: this.watchId });
    this.map?.remove();
  }
}
