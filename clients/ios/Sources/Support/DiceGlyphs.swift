import Foundation

/// Presentation helpers. No rules — just how to say things out loud.
///
/// Note what is deliberately *not* here: the Unicode die faces (⚀–⚅). They are missing from the
/// system font and render as a placeholder box on device, which is how "Revealed: 4 × ▫" reached a
/// screenshot. Dice are drawn now (`DieView`); text says the face in words.
extension Face {
    var spoken: String {
        switch self {
        case .one: "ones"
        case .two: "twos"
        case .three: "threes"
        case .four: "fours"
        case .five: "fives"
        case .six: "sixes"
        }
    }

    /// Singular, for "a four" rather than "a fours".
    ///
    /// Spelled out rather than derived: dropping the plural's last letter works for five of the
    /// six faces and turns "sixes" into "sixe", which is how "1 sixe" reached a screenshot.
    var spokenSingular: String {
        switch self {
        case .one: "one"
        case .two: "two"
        case .three: "three"
        case .four: "four"
        case .five: "five"
        case .six: "six"
        }
    }

    /// "1 four", "4 fours". English is the one thing here with no test in packages/engine.
    func spoken(count: Int) -> String {
        "\(count) \(count == 1 ? spokenSingular : spoken)"
    }
}

extension Bid {
    var spoken: String { face.spoken(count: quantity) }
}

/// A short name for a guest id, which is otherwise a UUID that wraps across the screen.
///
/// A free function rather than a method because two screens need it now — the match feed and the
/// private-game lobby — and neither should have to own the other's copy.
func shortName(_ playerId: String, me: String) -> String {
    if playerId == me { return "You" }
    if playerId.hasPrefix("bot_") { return "Bot \(playerId.suffix(4))" }
    let trimmed = playerId.hasPrefix("g_") ? String(playerId.dropFirst(2)) : playerId
    return "Player \(trimmed.prefix(4))"
}

/// How to refer to people in the event feed.
///
/// Two jobs, both learned from a real device. A guest id is a UUID, and a feed full of them wraps
/// across the screen while telling the reader nothing. And "You loses a die" is what happens when
/// third-person copy meets a second-person name, so the verb has to agree.
struct EventNaming {
    var name: (String) -> String = { $0 }
    var isMe: (String) -> Bool = { _ in false }

    /// "Dana bids" / "You bid".
    func subject(_ playerId: String, _ third: String, _ second: String) -> String {
        "\(name(playerId)) \(isMe(playerId) ? second : third)"
    }

    /// "Dana's" / "your".
    func possessive(_ playerId: String) -> String {
        isMe(playerId) ? "your" : "\(name(playerId))'s"
    }

    /// Ids as-is, third person. For tests and anywhere without a player.
    ///
    /// Computed rather than a stored `static let`: this type holds closures, which are not
    /// `Sendable`, and a stored global of a non-Sendable type is a concurrency error under
    /// Swift 6. A fresh value per call is free and sidesteps it.
    static var plain: EventNaming { EventNaming() }
}

extension ProtocolEvent {
    /// A one-line description for the event feed.
    func summary(_ naming: EventNaming = .plain) -> String {
        switch self {
        case .matchStarted(let event):
            "Match started — \(event.playerIds.count) players, \(event.startingDice) dice each"
        case .roundStarted(let event):
            "Round \(event.index + 1): \(naming.name(event.starterId)) opens"
        case .bidMade(let event):
            "\(naming.subject(event.playerId, "bids", "bid")) \(event.bid.spoken)"
        case .dudoCalled(let event):
            "\(naming.subject(event.playerId, "challenges", "challenge")) "
                + "\(naming.possessive(event.bidderId)) \(event.bid.spoken)"
        case .diceRevealed(let event):
            "Revealed: \(event.reveal.bid.face.spoken(count: event.reveal.actualCount)) — "
                + (event.reveal.bidStands ? "the bid was good" : "the bid was a lie")
        case .dieLost(let event):
            "\(naming.subject(event.playerId, "loses", "lose")) a die — \(event.diceCount) left"
        case .playerEliminated(let event):
            naming.subject(event.playerId, "is out", "are out")
        case .matchEnded(let event):
            naming.subject(event.winnerId, "wins", "win")
        case .playerTimedOut(let event):
            event.autoBid == nil
                ? "\(naming.name(event.playerId)) ran out of time again"
                : "\(naming.name(event.playerId)) ran out of time — a minimum raise was played"
        case .playerDisconnected(let event):
            naming.subject(event.playerId, "disconnected", "disconnected")
        case .playerReconnected(let event):
            naming.subject(event.playerId, "is back", "are back")
        case .botTookOver(let event):
            "A bot is playing \(naming.possessive(event.playerId)) seat (\(event.reason.rawValue))"
        case .controlReturned(let event):
            "\(naming.subject(event.playerId, "has", "have")) the seat back"
        case .matchAbandoned:
            "Match abandoned — everyone left"
        }
    }
}

extension ErrorCode {
    /// What to put in front of a player when the server refuses something.
    var readable: String {
        switch self {
        case .bidTooLow: "That bid does not raise the current one."
        case .bidExceedsDiceInPlay: "There are not that many dice on the table."
        case .bidQuantityInvalid: "That is not a valid quantity."
        case .bidFaceInvalid: "That is not a valid face."
        case .openingBidRequired: "You open the round, so you have to bid."
        case .notYourTurn: "It is not your turn."
        case .playerEliminated: "You are out of this match."
        case .matchEnded: "The match is over."
        case .seatNotYours: "A bot is playing your seat."
        case .rateLimited: "Slow down a moment."
        case .unknownMatch, .notInMatch: "That match has finished."
        case .unknownParty: "No game with that code. Check it and try again."
        case .partyFull: "That game is full."
        case .alreadyInParty: "You are already in a private game."
        case .notInParty: "You are not in a private game."
        case .notPartyHost: "Only the player who created the game can start it."
        case .partyTooSmall: "You need at least one other player to start."
        default: "The server refused that: \(rawValue)"
        }
    }
}
