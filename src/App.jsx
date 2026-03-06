import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Divider,
  Dialog,
  DialogTrigger,
  Flex,
  Heading,
  Item,
  Picker,
  Provider,
  Tabs,
  TabList,
  TabPanels,
  TableView,
  TableHeader,
  Column,
  TableBody,
  Row,
  Cell,
  SearchField,
  Text,
  TextField,
  View,
  defaultTheme,
} from '@adobe/react-spectrum';
import Minimize from '@spectrum-icons/workflow/Minimize';
import Refresh from '@spectrum-icons/workflow/Refresh';
import ShowMenu from '@spectrum-icons/workflow/ShowMenu';
import { Map, Marker, ZoomControl } from 'pigeon-maps';
import { isValidLatLon } from './utils';
import { ADSB_SERVICE, AIRCRAFT_SERVICE, CALLSIGN_SERVICE, GEO_SERVICE, GRID_SERVICE, MAP_SERVICE, VOACAP_SERVICE } from './config';
import MyPosition from './MyPosition.jsx';
import { bearing, haversineDistance, maidenhead } from './utils/distance';
import worldCities from './data/cities.json';
import './App.css';

function App() {
  const MIN_RELIABILITY = 90; // Minimum reliability threshold
  const FUTURE_HOURS = 24;    // Number of hours for "Later"

  const DEFAULT_ZOOM_REGION = 10; // Default zoom level for country-specific maps (i.e. US and CA).
  const DEFAULT_ZOOM_WORLD = 6;   // Default zoom level for world map.

  const [myPosition, setMyPosition] = useState([33.0, -112.0]);
  const [center, setCenter] = useState([33.0, -112.0]);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM_WORLD);

  const [useFallback, setUseFallback] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tileServices, setTileServices] = useState([]);

  // Callsign search state
  const [searchCallsign, setSearchCallsign] = useState('');
  const [searchResult, setSearchResult] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [isSearching, setIsSearching] = useState(false);

  // Lat/Lon search state
  const [latInput, setLatInput] = useState('');
  const [lonInput, setLonInput] = useState('');
  const [latLonError, setLatLonError] = useState(null);
  const [latLonMarker, setLatLonMarker] = useState(null);

  // City search state
  const [cityQuery, setCityQuery] = useState('');
  const [cityResults, setCityResults] = useState([]);
  const [cityMarker, setCityMarker] = useState(null);
  const [selectedCity, setSelectedCity] = useState(null);

  // Maidenhead Grid Search
  const [gridInput, setGridInput] = useState('');
  const [gridError, setGridError] = useState(null);
  const [gridMarker, setGridMarker] = useState(null);
  const [isGridSearching, setIsGridSearching] = useState(false);

  // Prediction state
  const [isPredicting, setIsPredicting] = useState(false);
  const [voacapResults, setVoacapResults] = useState(null);
  const [voacapError, setVoacapError] = useState(null);

  // VOACAP input
  const [power, setPower] = useState("5"); // in watts
  const [mode, setMode] = useState("js8"); // radio mode

  // Handle zoom level based on availability of offline regional vs world map
  const getDefaultZoom = () => {
    const hasRegional = tileServices.some(s => !s.url.includes('osm-world'));
    return hasRegional ? DEFAULT_ZOOM_REGION : DEFAULT_ZOOM_WORLD;
  };

  const handleReset = () => {
    setSearchCallsign('');
    setSearchResult(null);
    setSearchError(null);

    setLatInput('');
    setLonInput('');
    setLatLonMarker(null);
    setLatLonError(null);

    setGridInput('');
    setGridMarker(null);
    setGridError(null);

    setCityQuery('');
    setCityResults([]);
    setCityMarker(null);
    setSelectedCity(null);

    setVoacapResults(null);
    setVoacapError(null);
    setCenter([myPosition[0], myPosition[1]]);
    setZoom(getDefaultZoom());
  };

  // Load default location
  useEffect(() => {
    const fetchDefaultGrid = async () => {
      try {
        const response = await fetch(GEO_SERVICE);
        if (!response.ok) throw new Error('Failed to fetch default location');
        const data = await response.json();
        if (isValidLatLon(data)) {
          const { lat, lon } = data.position;
          setMyPosition([lat, lon]);
          setCenter([lat, lon]);
        }
      } catch (err) {
        console.warn('Could not load default location:', err);
      }
    };
    fetchDefaultGrid();
  }, []);

  // Load map tile service info — fetch all tilesets with their bounds
  useEffect(() => {
    async function fetchMapServices() {
      try {
        const response = await fetch(MAP_SERVICE);
        const services = await response.json();
        if (services.length === 0) {
          setUseFallback(true);
          setZoom(DEFAULT_ZOOM_REGION);
          return;
        }

        // Fetch TileJSON metadata for each service to get bounds/zoom
        const metadataPromises = services.map(async (svc) => {
          try {
            const res = await fetch(svc.url);
            const meta = await res.json();
            return {
              url: svc.url,
              tileUrl: meta.tiles?.[0] || `${svc.url}/tiles/{z}/{x}/{y}.png`,
              bounds: meta.bounds || [-180, -90, 180, 90],
              minzoom: meta.minzoom ?? 0,
              maxzoom: meta.maxzoom ?? 22,
              isWorld: svc.url.includes('osm-world'),
            };
          } catch {
            return null;
          }
        });

        const allMeta = (await Promise.all(metadataPromises)).filter(Boolean);

        // Sort: regional tilesets first (smallest area), world last
        allMeta.sort((a, b) => {
          if (a.isWorld !== b.isWorld) return a.isWorld ? 1 : -1;
          const areaA = (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]);
          const areaB = (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]);
          return areaA - areaB;
        });

        setTileServices(allMeta);
        const hasRegional = allMeta.some(s => !s.isWorld);
        setZoom(hasRegional ? DEFAULT_ZOOM_REGION : DEFAULT_ZOOM_WORLD);
      } catch (err) {
        console.error('Failed to fetch map services:', err);
        setUseFallback(true);
      }
    }
    fetchMapServices();
  }, []);

  const mapTiler = useCallback(
    (x, y, z, dpr) => {
      if (useFallback) {
        return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
      }
      if (tileServices.length === 0) return '';

      // Convert tile center to lat/lon
      const n = Math.pow(2, z);
      const lonDeg = ((x + 0.5) / n) * 360 - 180;
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
      const latDeg = (latRad * 180) / Math.PI;

      // At low zoom (within world tileset range), always use world for consistency
      const worldSvc = tileServices[tileServices.length - 1]; // world is sorted last
      if (worldSvc && worldSvc.isWorld && z <= worldSvc.maxzoom) {
        return worldSvc.tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      }

      // At higher zoom, find best regional tileset whose bounds contain the tile center
      for (const svc of tileServices) {
        const [west, south, east, north] = svc.bounds;
        if (z >= svc.minzoom && z <= svc.maxzoom &&
            lonDeg >= west && lonDeg <= east &&
            latDeg >= south && latDeg <= north) {
          return svc.tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        }
      }

      // No match — use world even if zoom exceeds its maxzoom (overzoom)
      if (worldSvc) {
        return worldSvc.tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      }
      return '';
    },
    [tileServices, useFallback]
  );

  // Handle callsign search
  const handleSearch = async () => {
    if (!searchCallsign) return;
    setSearchError(null);
    setIsSearching(true);
    setSearchResult(null);
    setLatLonError(null);
    setLatLonMarker(null);
    setGridMarker(null);
    setGridError(null);

    try {
      const response = await fetch(
        `${CALLSIGN_SERVICE}?callsign=${encodeURIComponent(searchCallsign)}`
      );
      if (!response.ok) throw new Error(`Search failed: ${response.status}`);
      const data = await response.json();

      if (data.lat && data.lon) {
        setSearchResult(data);
        setCenter([data.lat, data.lon]);
        setZoom(getDefaultZoom());
      } else {
        setSearchError('Callsign not found.');
      }
    } catch (err) {
      console.error('Search error:', err);
      setSearchError('Callsign not found.');
    } finally {
      setIsSearching(false);
    }
  };

  // Handle lat/lon search
  const handleLatLonSearch = () => {
    setLatLonError(null);
    setSearchError(null);
    setSearchResult(null);
    setGridMarker(null);
    setGridError(null);

    const lat = parseFloat(latInput);
    const lon = parseFloat(lonInput);

    if (isNaN(lat) || isNaN(lon)) {
      setLatLonError('Both latitude and longitude must be numbers.');
      return;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setLatLonError('Latitude must be between -90 and 90, longitude between -180 and 180.');
      return;
    }

    const coords = [lat, lon];
    setLatLonMarker(coords);
    setCenter(coords);
    setZoom(getDefaultZoom());
  };

  // City search — client-side fuzzy match on 5985 world cities
  const handleCitySearch = (query) => {
    setCityQuery(query);
    if (query.length < 2) {
      setCityResults([]);
      return;
    }
    const q = query.toLowerCase();
    const matches = worldCities
      .filter(c => c.a.toLowerCase().includes(q) || c.n.toLowerCase().includes(q))
      .slice(0, 12);
    setCityResults(matches);
  };

  const handleCitySelect = (city) => {
    const coords = [city.t, city.g];
    setCityMarker(coords);
    setSelectedCity(city);
    setCityQuery(city.n);
    setCityResults([]);
    setCenter(coords);
    setZoom(getDefaultZoom());
    // Clear other search results
    setSearchResult(null);
    setSearchError(null);
    setLatLonMarker(null);
    setLatLonError(null);
    setGridMarker(null);
    setGridError(null);
  };

  // Map click handler — right-click sets destination lat/lon
  const handleMapClick = ({ event, latLng }) => {
    if (!latLng) return;
    const [lat, lon] = latLng;
    setLatInput(lat.toFixed(4));
    setLonInput(lon.toFixed(4));
    setLatLonMarker([lat, lon]);
    setCenter([lat, lon]);
    // Clear other search results
    setSearchResult(null);
    setSearchError(null);
    setCityMarker(null);
    setSelectedCity(null);
    setGridMarker(null);
    setGridError(null);
  };

  // Determine target coordinates
  const getTargetCoords = () => {
    if (searchResult) return [searchResult.lat, searchResult.lon];
    if (latLonMarker) return latLonMarker;
    if (gridMarker) return gridMarker;
    if (cityMarker) return cityMarker;
    return null;
  };

  // Helper: map frequency (MHz) to amateur radio band
  const freqToBand = (freq) => {
    const f = parseFloat(freq);
    if (f >= 3.5 && f < 4.0) return '80m';
    if (f >= 5.3 && f < 5.5) return '60m';
    if (f >= 7 && f < 7.3) return '40m';
    if (f >= 10.1 && f < 10.15) return '30m';
    if (f >= 14 && f < 14.35) return '20m';
    if (f >= 18.068 && f < 18.168) return '17m';
    if (f >= 21 && f < 21.45) return '15m';
    if (f >= 24.89 && f < 24.99) return '12m';
    if (f >= 28 && f < 29.7) return '10m';
    return `${f} MHz`;
  };

  const handlePredict = async () => {
    const target = getTargetCoords();
    if (!target) return;

    setIsPredicting(true);
    setVoacapError(null);
    setVoacapResults(null);

    try {

      const payload = {
        txLatLon: `${myPosition[0]},${myPosition[1]}`,
        rxLatLon: `${target[0]},${target[1]}`,
        power: parseInt(power),
        mode: mode,
      };

      const response = await fetch(VOACAP_SERVICE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error(`Prediction failed: ${response.status}`);
      const data = await response.json(); // Expecting 24 entries

      const now = new Date();
      const nowHour = now.getUTCHours();
      const nowMinutes = now.getUTCMinutes();

      // "Now" predictions (filtered ≥ MIN_RELIABILITY)
      const currentHour = data[nowHour];
      const nowBands = Object.entries(currentHour.freqRel)
        .map(([freq, rel]) => ({
          freq: `${freq} MHz`,
          band: freqToBand(freq),
          reliability: Math.round(rel * 100),
        }))
        .filter(b => b.reliability >= MIN_RELIABILITY)
        .sort((a, b) => parseFloat(a.freq) - parseFloat(b.freq));

      // "Later" predictions (filtered ≥ MIN_RELIABILITY)
      const futureBands = [];
      const startHour = (nowMinutes === 0) ? (nowHour + 1) % 24 : (nowHour + 1) % 24;
      for (let i = 0; i < FUTURE_HOURS; i++) {
        const hourIndex = (startHour + i) % 24;
        const entry = data[hourIndex];
        Object.entries(entry.freqRel).forEach(([freq, rel]) => {
          const reliability = Math.round(rel * 100);
          if (reliability >= MIN_RELIABILITY) {
            futureBands.push({
              time: `${String(hourIndex).padStart(2, '0')}:00 UTC`,
              freq: `${freq} MHz`,
              band: freqToBand(freq),
              reliability,
            });
          }
        });
      }

      // Save filtered + raw
      setVoacapResults({
        now: nowBands,
        future: futureBands,
        raw: data // store raw 24-hour array for full table
      });

    } catch (err) {
      console.error(err);
      setVoacapError('Failed to get prediction.');
    } finally {
      setIsPredicting(false);
    }
  };

  const handleGridSearch = async () => {
    setGridError(null);
    setSearchError(null);
    setSearchResult(null);
    setLatLonMarker(null);

    const grid = gridInput.trim().toLowerCase();

    if (!grid || (grid.length !== 4 && grid.length !== 6)) {
      setGridError('Grid must be 4 or 6 characters.');
      return;
    }

    try {
      setIsGridSearching(true);

      const response = await fetch(
        `${GRID_SERVICE}?gridSquare=${encodeURIComponent(grid)}`
      );

      if (!response.ok) throw new Error(`Grid lookup failed: ${response.status}`);

      const data = await response.json();

      if (data?.position?.lat && data?.position?.lon) {
        const { lat, lon } = data.position;

        setGridMarker([lat, lon]);
        setCenter([lat, lon]);
        setZoom(getDefaultZoom());
      } else {
        setGridError('Grid not found.');
      }
    } catch (err) {
      console.error(err);
      setGridError('Grid not found.');
    } finally {
    setIsGridSearching(false);
    }
  };

  return (
    <Provider theme={defaultTheme}>
      <Flex direction="column" height="100vh">
        <Flex direction="row" flexGrow={1}>
          {/* Sidebar */}
          {sidebarOpen && (
            <View backgroundColor="gray-100" padding="size-200" width="size-4600">
              <Flex direction="column" gap="size-200">
                <Flex direction="row" gap="size-200" alignItems="center">
                  <ActionButton onPress={() => setSidebarOpen(false)} aria-label="Hide Panel">
                    <Minimize />
                    <Text>Hide</Text>
                  </ActionButton>
                  <MyPosition setMyPosition={setMyPosition} setCenter={setCenter} showText={true} />
	          <ActionButton onPress={handleReset}>
		    <Refresh />
		    <Text>Reset</Text>
		  </ActionButton>
                </Flex>

                {/* Callsign Search */}
                <Flex direction="row" gap="size-200" alignItems="end">
                  <SearchField
                    label="Callsign Lookup (US and Canadian only)"
                    placeholder="callsign"
                    value={searchCallsign}
                    onChange={setSearchCallsign}
                    onSubmit={handleSearch}
                    width="100%"
                  />
                  <Button variant="cta" onPress={handleSearch} isDisabled={isSearching}>
                    {isSearching ? 'Searching...' : 'Search'}
                  </Button>
                </Flex>

                {/* Lat/Lon Search */}
                <Flex direction="row" gap="size-200" alignItems="end">
                  <TextField label="Latitude" placeholder="33.45" value={latInput} onChange={setLatInput} width="50%" />
                  <TextField label="Longitude" placeholder="-111.93" value={lonInput} onChange={setLonInput} width="50%" />
                  <Button variant="cta" onPress={handleLatLonSearch}>Go</Button>
                </Flex>

                {/* Maidenhead Grid Search */}
                <Flex direction="row" gap="size-200" alignItems="end">
                  <TextField
                    label="Grid Square"
                    placeholder="DM32 or DM32UV"
                    value={gridInput}
                    onChange={setGridInput}
                    width="100%"
                  />
                  <Button variant="cta" onPress={handleGridSearch} isDisabled={isGridSearching} >
                   {isGridSearching ? 'Searching...' : 'Go'}
                  </Button>
                </Flex>

                {/* City Search */}
                <Flex direction="column" gap="size-50">
                  <TextField
                    label="City Search"
                    placeholder="London, Paris, Montreal..."
                    value={cityQuery}
                    onChange={handleCitySearch}
                    width="100%"
                  />
                  {cityResults.length > 0 && (
                    <div style={{
                      maxHeight: '180px', overflowY: 'auto',
                      border: '1px solid #555', borderRadius: '4px',
                      background: '#2a2a2a'
                    }}>
                      {cityResults.map((city, i) => (
                        <div
                          key={i}
                          style={{
                            padding: '6px 8px', cursor: 'pointer',
                            borderBottom: '1px solid #444', fontSize: '13px',
                            color: '#e0e0e0'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = '#3a3a5a'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                          onClick={() => handleCitySelect(city)}
                        >
                          {city.n}, {city.c} <span style={{ color: '#888' }}>({(city.p / 1000).toFixed(0)}K)</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Flex>

                {gridError && ( <Text UNSAFE_style={{ color: 'red' }}>{gridError}</Text>)}
                {latLonError && <Text UNSAFE_style={{ color: 'red' }}>{latLonError}</Text>}
                {searchError && <Text UNSAFE_style={{ color: 'red' }}>{searchError}</Text>}

                {/* Callsign Result */}
                {searchResult && (
                  <View backgroundColor="gray-200" padding="size-100" borderRadius="regular" marginTop="size-200">
                    <Text><b>{searchResult.firstName}</b> {searchResult.callsign}</Text>
                    <br />
                    <Text>Lat/Lon: {searchResult.lat.toFixed(4)}, {searchResult.lon.toFixed(4)}</Text>
                    <br />
                    <Text>{searchResult.city}, {searchResult.state} {searchResult.zip}</Text>
                    <br />
                    <Text>Grid: {searchResult.grid}</Text>
                    <br />
                    <Text>Distance: {searchResult.distance.toFixed(2)} mi</Text>
                    <br />
                    <Text>Bearing: {searchResult.bearing}°</Text>
                  </View>
                )}

                {/* Lat/Lon marker info */}
                {latLonMarker && (
                  <View backgroundColor="gray-200" padding="size-100" borderRadius="regular" marginTop="size-200">
                    <Text><b>Coordinates</b></Text>
                    <br />
                    <Text>Lat/Lon: {latInput}, {lonInput}</Text>
                    <br />
		    <Text>Grid: {maidenhead([parseFloat(latInput), parseFloat(lonInput)])}</Text>
                    <br />
                    <Text>Distance: {haversineDistance(myPosition, latLonMarker, 'mi').toFixed(2)} mi</Text>
                    <br />
                    <Text>Bearing: {bearing(myPosition, [parseFloat(latInput), parseFloat(lonInput)]).toFixed(1)}°</Text>
                  </View>
                )}

                {gridMarker && (
                  <View backgroundColor="gray-200" padding="size-100" borderRadius="regular" marginTop="size-200">
                    <Text><b>Grid Square</b></Text>
                    <br />
                    <Text>Lat/Lon: {gridMarker[0].toFixed(5)}, {gridMarker[1].toFixed(5)}</Text>
                    <br />
                    <Text>Grid: {gridInput.toUpperCase()}</Text>
                    <br />
                    <Text>Distance: {haversineDistance(myPosition, gridMarker, 'mi').toFixed(2)} mi</Text>
                    <br />
                    <Text>Bearing: {bearing(myPosition, gridMarker).toFixed(1)}°</Text>
                  </View>
                )}

                {/* City search result */}
                {selectedCity && cityMarker && (
                  <View backgroundColor="gray-200" padding="size-100" borderRadius="regular" marginTop="size-200">
                    <Text><b>{selectedCity.n}</b>, {selectedCity.c}</Text>
                    <br />
                    <Text>Lat/Lon: {cityMarker[0].toFixed(4)}, {cityMarker[1].toFixed(4)}</Text>
                    <br />
                    <Text>Grid: {maidenhead(cityMarker)}</Text>
                    <br />
                    <Text>Distance: {haversineDistance(myPosition, cityMarker, 'mi').toFixed(2)} mi</Text>
                    <br />
                    <Text>Bearing: {bearing(myPosition, cityMarker).toFixed(1)}°</Text>
                  </View>
                )}

                {/* Prediction parameters: power and mode */}
                {(searchResult || latLonMarker || gridMarker || cityMarker) && (
                  <Flex direction="row" gap="size-200" alignItems="end">
                    <Picker
                      label="Power (Watts)"
                      selectedKey={power}
                      onSelectionChange={setPower}
                      width="50%"
                    >
                      {["5","10","20","50","100","500","1500"].map((p) => (
                        <Item key={p}>{p}</Item>
                      ))}
                    </Picker>

                    <Picker
                      label="Mode"
                      selectedKey={mode}
                      onSelectionChange={setMode}
                      width="50%"
                    >
                      {["am","ardop","cw","js8","ssb", "vara-500", "vara-2300", "vara-2750"].map((m) => (
                        <Item key={m}>{m.toUpperCase()}</Item>
                      ))}
                    </Picker>
                  </Flex>
		)}

                {/* Predict Button + Modal */}
                {(searchResult || latLonMarker || gridMarker || cityMarker) && (

                  <DialogTrigger onOpenChange={handlePredict}>
                    <Button variant="cta" isDisabled={isPredicting}>
                      {isPredicting ? 'Predicting...' : 'Predict'}
                    </Button>
                    {(close) => (
                      <Dialog>
                        <Heading>HF Prediction</Heading>
                        <Divider />
                        <Content>
                          {voacapError && <Text color="negative">{voacapError}</Text>}
                          {!voacapResults && !voacapError && <Text>Running prediction...</Text>}
                          {voacapResults && (
                            <Tabs aria-label="VOACAP Results" defaultSelectedKey="now">
                              <TabList>
                                <Item key="now">Now</Item>
                                <Item key="later">Later</Item>
                                <Item key="plan24">24-hour Plan</Item>
                              </TabList>
                              <TabPanels>
                                <Item key="now">
                                  <TableView aria-label="Now Bands" width="100%">
                                    <TableHeader>
                                      <Column>Band</Column>
                                      <Column>Frequency</Column>
                                      <Column>Reliability</Column>
                                    </TableHeader>
                                    <TableBody>
                                      {voacapResults.now.map((band) => (
                                        <Row key={band.freq}>
                                          <Cell>{band.band}</Cell>
                                          <Cell>{band.freq}</Cell>
                                          <Cell>{band.reliability}%</Cell>
                                        </Row>
                                      ))}
                                    </TableBody>
                                  </TableView>
                                </Item>

                                <Item key="later">
                                  <Flex direction="column" gap="size-100">
                                    {(() => {
                                      const hourGroups = {};
                                      voacapResults.future.forEach((entry) => {
                                        const hour = parseInt(entry.time.split(':')[0], 10);
                                        if (!hourGroups[hour]) hourGroups[hour] = [];
                                        hourGroups[hour].push(entry);
                                      });

                                      // Determine the starting hour (next UTC hour)
                                      const nowUTC = new Date();
                                      const nextHour = (nowUTC.getUTCHours() + 1) % 24;

                                      // Rotate hours starting from nextHour
                                      const sortedHours = [];
                                      for (let i = 0; i < 24; i++) {
                                        const hour = (nextHour + i) % 24;
                                        if (hourGroups[hour]) {
                                          sortedHours.push(hour);
                                        }
                                      }

                                      return sortedHours.map((hour, idx) => {
                                        const entries = hourGroups[hour];
                                        return (
                                          <View
                                            key={hour}
                                            padding="size-200"
                                            marginBottom="size-100"
                                            borderRadius="regular"
                                            borderWidth="thin"
                                            borderColor="default"
                                            shadow="regular"
                                            UNSAFE_style={{
                                              background: idx % 2 === 0
                                                ? 'linear-gradient(145deg, #fafafa, #e5e5e5)'
                                                : 'linear-gradient(145deg, #ebf5ff, #d0e5ff)',
                                            }}
                                          >
                                            <Text><b>{String(hour).padStart(2, '0')}:00 UTC</b></Text>

                                            <Flex direction="column" gap="size-100" marginTop="size-100">
                                              {entries.map((e, i) => (
                                                <Flex
                                                  key={i}
                                                  direction="row"
                                                  justifyContent="space-between"
                                                  paddingY="size-50"
                                                  paddingX="size-100"
                                                  backgroundColor="#ffffff"
                                                  borderRadius="regular"
                                                  shadow="small"
                                                >
                                                  <Text>{e.band}</Text>
                                                  <Text>{e.freq}</Text>
                                                  <Text>{e.reliability}%</Text>
                                                </Flex>
                                              ))}
                                            </Flex>
                                          </View>
                                        );
                                      });
                                    })()}
                                  </Flex>
                                </Item>

                                <Item key="plan24">
                                  {voacapResults?.raw && (
                                    (() => {
                                      const allBands = ['80m','60m','40m','30m','20m','17m','15m','12m','10m'];

                                      const hourRows = [];
                                      for (let hour = 0; hour < 24; hour++) {
                                        const row = { time: `${String(hour).padStart(2, '0')}:00 UTC` };
                                        allBands.forEach(b => { row[b] = ''; });

                                        const hourData = voacapResults.raw[hour];
                                        if (hourData) {
                                          Object.entries(hourData.freqRel).forEach(([freq, rel]) => {
                                            const band = freqToBand(freq);
                                            if (band && allBands.includes(band)) {
                                              row[band] = Math.round(rel * 100); // store as number
                                            }
                                          });
                                        }

                                        hourRows.push(row);
                                      }

                                      const getColor = (pct) => {
                                        if (pct === '' || pct == null) return '#ffffff';
                                        if (pct >= 90) return '#4caf50'; // green
                                        if (pct >= 70) return '#ffeb3b'; // yellow
                                        if (pct >= 50) return '#ff9800'; // orange
                                        return '#f44336'; // red
                                      };

                                      const currentHourUTC = new Date().getUTCHours();

                                      return (
                                        <div style={{ overflowX: 'auto', marginTop: 10 }}>
                                          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                                            <thead>
                                              <tr>
                                                <th style={{ border: '1px solid #ccc', padding: '4px', background: '#f0f0f0' }}>Time (UTC)</th>
                                                {allBands.map(b => (
                                                  <th key={b} style={{ border: '1px solid #ccc', padding: '4px', background: '#f0f0f0' }}>{b}</th>
                                                ))}
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {hourRows.map((r, idx) => {
                                                const isCurrentHour = parseInt(r.time.split(':')[0], 10) === currentHourUTC;

                                                // Repeat header every 6 rows
                                                const showRepeatHeader = idx > 0 && idx % 6 === 0;

                                                return (
                                                  <>
                                                    {showRepeatHeader && (
                                                      <tr key={`repeat-${idx}`}>
                                                        <th style={{ border: '1px solid #ccc', padding: '4px', background: '#f0f0f0' }}>Time (UTC)</th>
                                                        {allBands.map(b => (
                                                          <th key={`repeat-${idx}-${b}`} style={{ border: '1px solid #ccc', padding: '4px', background: '#f0f0f0' }}>{b}</th>
                                                        ))}
                                                      </tr>
                                                    )}

                                                    <tr key={idx}>
                                                      <td
                                                        style={{
                                                          border: '1px solid #ccc',
                                                          padding: '4px',
                                                          backgroundColor: isCurrentHour ? '#2196f3' : '#ffffff',
                                                          color: isCurrentHour ? '#ffffff' : '#000000',
                                                          fontWeight: isCurrentHour ? 'bold' : 'normal'
                                                        }}
                                                      >
                                                        {r.time}
                                                      </td>
                                                      {allBands.map(b => {
                                                        const pct = r[b];
                                                        return (
                                                          <td
                                                            key={b}
                                                            style={{
                                                              border: '1px solid #ccc',
                                                              padding: '4px',
                                                              textAlign: 'center',
                                                              backgroundColor: getColor(pct)
                                                            }}
                                                          >
                                                            {pct !== '' ? `${pct}%` : ''}
                                                          </td>
                                                        );
                                                      })}
                                                    </tr>
                                                  </>
                                                );
                                              })}
                                            </tbody>
                                          </table>
                                        </div>
                                      );
                                    })()
                                  )}
                                </Item>

                              </TabPanels>
                            </Tabs>
                          )}
                        </Content>
                        <ButtonGroup>
                          <Button variant="secondary" onPress={close}>Close</Button>
                        </ButtonGroup>
                      </Dialog>
                    )}
                  </DialogTrigger>
                )}
              </Flex>
            </View>
          )}

          {/* Sidebar toggle */}
          {!sidebarOpen && (
            <View backgroundColor="gray-100" padding="size-100">
              <Flex direction="column" gap="size-200">
                <ActionButton onPress={() => setSidebarOpen(true)} aria-label="Show Panel">
                  <ShowMenu />
                </ActionButton>
                <MyPosition setMyPosition={setMyPosition} setCenter={setCenter} showText={false} />
              </Flex>
            </View>
          )}

          {/* Map */}
          <View flexGrow={1}>
            <View backgroundColor="gray-200" borderWidth="thin" borderColor="dark" padding="size-50">
              <Text>Your Position: {myPosition[0].toFixed(4)},{myPosition[1].toFixed(5)}</Text>
            </View>

            <Map
              attributionPrefix="The Tech Prepper | Pigeon Maps"
              provider={mapTiler}
              height="100%"
              center={center}
              zoom={zoom}
              minZoom={2}
              maxZoom={12}
              onBoundsChanged={({ center, zoom }) => {
                setCenter(center);
                setZoom(zoom);
              }}
              onClick={handleMapClick}
            >
              <ZoomControl />
              <Marker anchor={myPosition} />
              {searchResult && (
                <Marker
                  anchor={[searchResult.lat, searchResult.lon]}
                  payload={searchResult.callsign}
                  color="#e03e3e"
                />
              )}
              {latLonMarker && <Marker anchor={latLonMarker} color="#007aff" />}

              {gridMarker && <Marker anchor={gridMarker} color="#007aff" />}
              {cityMarker && <Marker anchor={cityMarker} color="#e68a00" />}
            </Map>
          </View>
        </Flex>
      </Flex>
    </Provider>
  );
}

export default App;
