"""District headquarters coordinates for Tamil Nadu, used as the reference
point for fetching weather when a farmer hasn't given an exact location.
Keys match the (upper-case) district names produced by process_data.py."""

TN_DISTRICTS = {
    "ARIYALUR": (11.1401, 79.0786),
    "CHENGALPATTU": (12.6819, 79.9888),
    "CHENNAI": (13.0827, 80.2707),
    "COIMBATORE": (11.0168, 76.9558),
    "CUDDALORE": (11.7480, 79.7714),
    "DHARMAPURI": (12.1211, 78.1582),
    "DINDIGUL": (10.3673, 77.9803),
    "ERODE": (11.3410, 77.7172),
    "KALLAKURICHI": (11.7384, 78.9639),
    "KANCHIPURAM": (12.8342, 79.7036),
    "KANNIYAKUMARI": (8.1833, 77.4119),         # Nagercoil
    "KARUR": (10.9601, 78.0766),
    "KRISHNAGIRI": (12.5186, 78.2137),
    "MADURAI": (9.9252, 78.1198),
    "NAGAPATTINAM": (10.7672, 79.8449),
    "NAMAKKAL": (11.2189, 78.1677),
    "PERAMBALUR": (11.2342, 78.8808),
    "PUDUKKOTTAI": (10.3833, 78.8001),
    "RAMANATHAPURAM": (9.3639, 78.8395),
    "RANIPET": (12.9272, 79.3333),
    "SALEM": (11.6643, 78.1460),
    "SIVAGANGA": (9.8433, 78.4809),
    "TENKASI": (8.9594, 77.3152),
    "THANJAVUR": (10.7870, 79.1378),
    "THE NILGIRIS": (11.4102, 76.6950),         # Udhagamandalam
    "THENI": (10.0104, 77.4768),
    "THIRUVALLUR": (13.1431, 79.9086),
    "THIRUVARUR": (10.7661, 79.6344),
    "THOOTHUKUDI": (8.7642, 78.1348),
    "TIRUCHIRAPPALLI": (10.7905, 78.7047),
    "TIRUNELVELI": (8.7139, 77.7567),
    "TIRUPATHUR": (12.4961, 78.5730),
    "TIRUPPUR": (11.1085, 77.3411),
    "TIRUVANNAMALAI": (12.2253, 79.0747),
    "VELLORE": (12.9165, 79.1325),
    "VILLUPURAM": (11.9401, 79.4861),
    "VIRUDHUNAGAR": (9.5850, 77.9570),
}

# The source file lists Thoothukudi under both of its names.
DISTRICT_ALIASES = {"TUTICORIN": "THOOTHUKUDI"}


def display_name(district):
    """'THE NILGIRIS' -> 'The Nilgiris'."""
    return district.title()


# Districts created after the older administrative boundaries / satellite polygons
# were drawn. A new district has no polygon of its own in older boundary sets and
# little or no yield history, so it borrows its parent's polygon and history. Any
# value derived this way is labelled with its parent in the UI and exports.
PARENT = {
    "CHENGALPATTU": "KANCHIPURAM",
    "KALLAKURICHI": "VILLUPURAM",
    "RANIPET": "VELLORE",
    "TIRUPATHUR": "VELLORE",
    "TENKASI": "TIRUNELVELI",
    "TIRUPPUR": "COIMBATORE",
}

# Spelling variants seen in boundary datasets (FAO GAUL etc.), upper-case.
BOUNDARY_NAME_VARIANTS = {
    "KANCHIPURAM": ["KANCHEEPURAM", "KANCHIPURAM"],
    "VILLUPURAM": ["VILUPPURAM", "VILLUPURAM"],
    "TIRUCHIRAPPALLI": ["TIRUCHIRAPPALLI", "TIRUCHCHIRAPPALLI", "TIRUCHIRAPALLI"],
    "THE NILGIRIS": ["NILGIRIS", "THE NILGIRIS"],
    "THOOTHUKUDI": ["TUTICORIN", "THOOTHUKKUDI", "THOOTHUKUDI"],
    "THIRUVALLUR": ["TIRUVALLUR", "THIRUVALLUR"],
    "THIRUVARUR": ["TIRUVARUR", "THIRUVARUR"],
    "TIRUVANNAMALAI": ["TIRUVANNAMALAI", "THIRUVANNAMALAI"],
    "KANNIYAKUMARI": ["KANYAKUMARI", "KANNIYAKUMARI"],
}


def data_district(district):
    """The district whose yield history / polygon stands in for `district`
    (itself unless it is a newly created district listed in PARENT)."""
    return PARENT.get(district, district)
