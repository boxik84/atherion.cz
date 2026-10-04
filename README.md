# Atherion Coach – live tep pre trénerov

Webová aplikácia, v ktorej tréner vidí **live tep celej skupiny** na jednej obrazovke.
Funguje s Garmin HRM pásmi (HRM 600, HRM-Pro, HRM-Pro Plus, HRM-Dual, HRM-Fit, HRM 200), Garmin hodinkami aj s inými pásmi cez **Bluetooth** alebo **ANT+**.
Nič sa neinštaluje a nie je potrebný server: stačí otvoriť stránku v Chrome alebo Edge.

## Čo aplikácia vie

- **Live tep** každého športovca: veľké číslo, % max. tepu, tepová zóna Z1–Z5, farba dlaždice podľa zóny a graf za posledné 2 minúty.
- **HRV (RMSSD) a RR intervaly** z HRM pásu.
- **Tempo, rýchlosť a kadencia** z HRM-Pro Plus (Bluetooth RSC) a ANT+ foot podov.
- **Výkon a kadencia** z wattmetrov (Bluetooth Cycling Power / ANT+ Power).
- **Batéria** senzora (pri ANT+ aj stav batérie) a sila signálu.
- **Tréning**: štart, pauza a kolá/intervaly. Pre každého športovca počíta Ø a max tep, kalórie, vzdialenosť a čas v zónach.
- **Súhrn** po tréningu: Ø tep po kolách, export **CSV** pre celú skupinu a **TCX** pre každého športovca (dá sa nahrať do Garmin Connect, Stravy či TrainingPeaks).
- **Športovci**: meno, vek, pohlavie, váha, max. a pokojový tep. Ak je zadaný pokojový tep, zóny sa počítajú metódou Karvonen. Senzory sa priraďujú športovcom a priradenie sa pamätá.
- **Upozornenie** pri tepe nad 95 % (blikajúca dlaždica, voliteľne aj pípnutie).
- Detail športovca s grafom za 5, 15 alebo 60 minút a časom v zónach.
- Obrazovka počas pripojenia nezhasne (Wake Lock), aplikácia má režim celej obrazovky a funguje aj offline (PWA).
- **Demo režim** so simulovanými dátami (tlačidlo *Demo* alebo `?demo` v URL).

## Pripojenie

| Spôsob | Čo treba | Poznámka |
|---|---|---|
| **Bluetooth** | Chrome/Edge na Windows, macOS, Linuxe alebo Androide; na iOS aplikácia **Bluefy** | Každý pás sa pridáva cez tlačidlo *Bluetooth*. HRM 600 zvládne 3 BLE spojenia naraz, HRM-Pro/Dual 2, takže hodinky športovca môžu ostať pripojené. |
| **ANT+ USB stick** | Garmin USB ANT Stick / ANT USB-m / USB2, Chrome/Edge (WebUSB) | Stick beží v *scan* režime a zachytí **všetky** ANT+ pásy, foot pody a wattmetre v dosahu naraz, bez párovania. Najlepšia voľba pre skupinu. |
| **Garmin hodinky** | Na hodinkách zapnúť *Vysielanie srdcového tepu* | Hodinky sa potom správajú ako pás, cez BLE aj ANT+. |

### ANT+ stick podľa systému
- **Windows:** sticku treba priradiť ovládač **WinUSB**, napríklad cez [Zadig](https://zadig.akeo.ie/). Garmin Express a iné ANT aplikácie musia byť zatvorené.
- **Linux:** treba udev pravidlo, aby mal prehliadač prístup k zariadeniu:
  `SUBSYSTEM=="usb", ATTRS{idVendor}=="0fcf", MODE="0666"`
- **macOS / Android (USB OTG):** zvyčajne funguje bez nastavovania.

## Spustenie

Web Bluetooth a WebUSB fungujú iba cez **HTTPS** alebo na `localhost`.

```bash
npm start          # http://localhost:8080
npm test           # unit testy dekodérov (Node 18+)
```

Aplikácia je čisto statická (HTML, CSS a ES moduly bez build kroku), takže ju GitHub Pages hostuje priamo na doméne z `CNAME` (atherion.cz).

## Štruktúra

```
index.html            UI
css/app.css           štýly (tmavá aj svetlá téma)
js/app.js             stav, dlaždice, tréning, dialógy
js/ble.js             Web Bluetooth (Heart Rate, RSC, Cycling Power, batéria, auto-reconnect)
js/ant.js             ANT+ cez WebUSB (scan režim, HR / SDM / Power)
js/parsers.js         dekodéry BLE charakteristík a ANT+ stránok (testované)
js/metrics.js         zóny, Karvonen, RMSSD, kalórie (Keytel)
js/chart.js           canvas grafy
js/export.js          CSV a TCX export
js/demo.js            simulované senzory
sw.js                 offline cache
tests/                node --test
```
