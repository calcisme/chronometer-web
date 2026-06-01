export type ExtraCity = {
    name: string;
    latitude: number;
    longitude: number;
    olsonTimezone: string;
    countryCode: string;
    population: number;
}

export const extraCities: ExtraCity[] = [
    {
        name: "Dolphin Island", latitude: -17.3053513,
        longitude: 178.2253116, olsonTimezone: 'Pacific/Fiji',
        countryCode: 'FJ', population: 10
    }
];
