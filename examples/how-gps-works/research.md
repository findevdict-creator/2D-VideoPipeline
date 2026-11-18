# Research: How Your Phone Knows Where You Are (GPS in 75 Seconds)

Researched 2026-11-18. The official gps.gov, NAVCEN and NASA pages could not be opened directly from this environment (the proxy refused the connection), so I checked their wording through search-result excerpts and archived copies. Every figure below matches across at least two sources.

## 1. Hook: accuracy and altitude

- GPS-enabled smartphones are typically accurate to within about **4.9 m (16 ft) radius under open sky**. Accuracy gets worse near buildings, bridges and trees. This supports the line "to within a few metres". — https://www.gps.gov/systems/gps/performance/accuracy/ (archived: https://archive.gps.gov/systems/gps/performance/accuracy/)
- GPS satellites fly in medium Earth orbit at about **20,200 km (12,550 miles)** altitude. Saying "about 20,000 km overhead" is fine. — https://www.gps.gov/systems/gps/space
- Each satellite **circles the Earth twice a day**, with an orbit of just under 12 hours. — https://www.gps.gov/systems/gps/space
- Picture it: 20,200 km is about 50 times higher than the International Space Station (~400 km), and roughly one and a half times the width of the Earth (Earth's diameter is ~12,700 km). *(These comparisons are my own arithmetic from the figures above. Check before using them on screen.)*

## 2. The constellation and atomic clocks

- The system is designed around **24 baseline "slots" in six orbital planes**. That layout ensures users can see **at least four satellites from virtually any point on the planet**. — https://www.gps.gov/systems/gps/space ; corroborated by https://gssc.esa.int/navipedia/index.php/GPS_Space_Segment
- In practice more than 24 satellites fly. gps.gov listed **31 operational satellites** (as of July 2023), and a NAVCEN-based count gives **32 operational as of October 2026**, after the final GPS III launched in April 2026. **Use "about 30" or "more than 30" in the script.** Both are safe, and the brief's "roughly 30" is fine. — https://archive.gps.gov/systems/gps/space/ ; https://www.navcen.uscg.gov/gps-constellation ; https://keeptrack.space/live-count/how-many-gps-satellites-are-there
- NASA: the constellation has **over 30 operational satellites, each equipped with redundant atomic clocks**, meaning several clocks on each satellite as backups. — https://www.nasa.gov/specials/what-is-gps
- The satellite clocks are atomic clocks (rubidium and/or caesium) stable to within a few billionths of a second. Phone receivers use a cheap quartz clock instead, because an atomic clock would be far too expensive and bulky for a phone. — https://en.wikipedia.org/wiki/Pseudorange ; https://www.remnote.com/learn/engineering/electrical-engineering/global-positioning-system-position-computation-fundamentals-study-deck

## 3. What the signal carries; the receiver only listens

- Each satellite continuously broadcasts **its own position and the exact time the signal was sent**, stamped by its onboard atomic clock. — https://www.nasa.gov/specials/what-is-gps ; https://www.scienceabc.com/innovation/how-does-satellite-navigation-work
- GPS is **one-way**. In Penn State's GPS course, "the satellites transmit signals; the users receive them." A GPS receiver never sends anything back to the satellites. — https://www.e-education.psu.edu/geog862/node/1732 ; https://www.iflscience.com/your-sat-nav-does-not-ping-any-satellites-so-how-does-gps-actually-work-75331
- Because receivers only listen, **the satellites have no idea who is using them**, and any number of people can use GPS at once without overloading it. — https://www.iflscience.com/your-sat-nav-does-not-ping-any-satellites-so-how-does-gps-actually-work-75331 ; https://techreviewadvisor.com/how-gps-works/
- Analogy: it works like a lighthouse or a radio station. Many people can see or hear it, but it can't see or hear them.

## 4. Time × speed of light = distance

- Radio waves travel at the speed of light, **exactly 299,792,458 m/s** in a vacuum. In the script, "about 300,000 km per second" is fine. — https://physics.nist.gov/cuu/Constants/Value/c.html
- From a satellite directly overhead (~20,000 km), the signal takes **about 0.067 s (roughly one-fifteenth of a second)** to arrive. Britannica describes it as "less than a tenth of a second". — https://www.sciencenewstoday.org/how-do-gps-galileo-and-other-satellite-navigation-systems-work ; https://www.britannica.com/technology/GPS
- The receiver compares the time the signal was sent (in the message) with the time it arrived (by its own clock). The difference is the travel time. **distance = travel time × speed of light.** — https://www.seos-project.uni-oldenburg.de/GPS/GPS-c01-p02.html ; https://www.scienceabc.com/innovation/how-does-satellite-navigation-work
- Analogy: it's like counting the seconds between lightning and thunder to tell how far away a storm is. GPS uses light instead of sound, so it has to time things far more precisely.

## 5. Trilateration: circles in 2D, then spheres in 3D

- Knowing your distance from one satellite puts you **somewhere on a sphere** centred on that satellite. With distances from several satellites, the spheres meet at one point. — https://www.seos-project.uni-oldenburg.de/GPS/GPS-c01-p02.html ; https://www.scienceabc.com/innovation/how-does-satellite-navigation-work
- **2D version for the flat-map scene:** one distance gives a circle, so you could be anywhere on it. Two circles cross at **two points**. A third circle passes through only **one** of those points, and that's you. *(This is standard geometry and matches the SEOS trilateration lesson above.)*
- **3D version:** two spheres meet in a circle, and a third sphere cuts that circle at two points. One of those points is usually far out in space or moving impossibly fast, so it can be ruled out. In the real system, the fourth satellite settles it (see section 6). — https://www.seos-project.uni-oldenburg.de/GPS/GPS-c01-p02.html
- The name is **tri*lateration***, which uses distances, not **tri*angulation***, which uses angles. — https://www.scienceabc.com/innovation/how-does-satellite-navigation-work

## 6. Why four satellites: fixing the phone's clock

- The receiver has **four unknowns**: three for position (east–west, north–south, up–down) plus **its own clock error**. Four unknowns need four measurements, so it needs **at least four satellites**. — https://en.wikipedia.org/wiki/Pseudorange ; https://www.gnss.ca/gnss/1321-step-4-computation
- **1 microsecond (a millionth of a second) of clock error ≈ 300 m of distance error** (299,792,458 m/s × 0.000001 s ≈ 300 m). Likewise, **1 nanosecond ≈ 30 cm**. This confirms the brief's "about 300 metres" figure. — https://usq.pressbooks.pub/gpsandgnss/?p=291 ; https://www.remnote.com/learn/engineering/electrical-engineering/global-positioning-system-position-computation-fundamentals-study-deck
- The phone measures all the signals with the same clock, so **every distance is off by the same amount**. These slightly wrong distances are called "pseudoranges". Because the error is shared, it can be calculated: the receiver adjusts its assumed clock error until all four spheres meet at one point. — https://en.wikipedia.org/wiki/Pseudorange ; https://thenauticalalmanac.com/2002_Bowditch-_American_Practical_Navigator/Chapt-11%20SATELLITE%20NAVIGATION.pdf
- Result: the precision of the satellites' atomic clocks is effectively **"transferred" to the phone**, so a cheap phone also ends up knowing the time very precisely. — https://www.gnss.ca/gnss/1321-step-4-computation
- Visual idea for the "tick offset": if the phone's clock is a little off, all the circles grow or shrink together and stop meeting at one point. Shift the clock by the right amount and they snap together.
- Analogy: four friends each tell you how far away they are, but your watch runs a bit fast. Their answers don't agree until you correct your watch, and then they all point to the same spot.

## 7. Closing: the blue dot

- Your phone repeats this calculation continuously, over and over each second, so the location dot follows you as you move. *(General description. Avoid quoting a specific update rate.)* — https://www.scienceabc.com/innovation/how-does-satellite-navigation-work
- The open-sky figure (~4.9 m) is why the blue dot is usually accurate to "a few metres". The pale circle around the dot shows the phone's uncertainty. — https://www.gps.gov/systems/gps/performance/accuracy/

## Common misconceptions to avoid or correct

- **"My phone pings the satellites" or "satellites track me."** False. GPS is receive-only, and the satellites never hear from your phone. (Any tracking comes from apps or the mobile network, which is out of scope, so don't go there.) — https://www.iflscience.com/your-sat-nav-does-not-ping-any-satellites-so-how-does-gps-actually-work-75331
- **"GPS uses triangulation."** Strictly, it's trilateration, using distances rather than angles. Say "trilateration", or just "combining distances". — https://www.scienceabc.com/innovation/how-does-satellite-navigation-work
- **"Three satellites are enough."** Only if your clock were perfect. With a phone's clock, you need four. — https://en.wikipedia.org/wiki/Pseudorange
- **"The phone has an atomic clock."** No. The atomic clocks are on the satellites, and the phone uses a cheap quartz clock that the fourth satellite corrects. — https://www.remnote.com/learn/engineering/electrical-engineering/global-positioning-system-position-computation-fundamentals-study-deck
- **"GPS needs internet or mobile data."** The core GPS fix only needs satellite signals. Don't claim more than that, because phone-assisted positioning is out of scope.
- **Don't say "exactly 24 satellites"** (that's the design minimum) **or "orbits once a day"** (it's twice).

## Safe on-screen numbers

| Label | Value |
|---|---|
| Altitude | ~20,000 km |
| Satellites | ~30 (31–32 operational) |
| Orbits per day | 2 |
| Signal travel time | ~0.07 s |
| Speed of light | ~300,000 km/s |
| Formula | distance = time × speed of light |
| 1 µs clock error | ~300 m off |
| Satellites needed | 4 (3 for position + 1 for the clock) |
| Phone accuracy (open sky) | ~5 m |
