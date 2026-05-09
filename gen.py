for i in range(24):
    for half in [0, 1]:
        hour = i + (0.5 if half else 0.0)
        name = f"t24_{i}_{half}"
        width = "2" if half == 0 else "1"
        lineWidth = "1.5" if half == 0 else ".75"
        print(f"  <Qhand name='{name}' x='0' y='0' modes='front' type='wire' width='{width}' lineWidth='{lineWidth}' length='hrRad' length2='hrRad-5' angle='kyMode==0 ? {hour}*pi/12+pi : temporalAngleFor24Hour({hour})' update='updateAtNextSunriseOrSunset' />")
